import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../bin/review-docker.sh', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'docker-review-'));
after(() => rm(work, { recursive: true, force: true }));
const repo = join(work, 'project with spaces');
const linked = join(work, 'linked');
const stub = join(work, 'bin');
await mkdir(repo);
await mkdir(stub);
const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
await git('init', '-q');
await git('commit', '--allow-empty', '-qm', 'base');
await git('worktree', 'add', '--detach', linked, 'HEAD');
await writeFile(join(stub, 'docker'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.DOCKER_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.DOCKER_TEST_EXIT || 0));
`, { mode: 0o755 });

async function invoke(t, args, extra = {}) {
  const capture = join(work, `${t.name}.json`);
  await rm(capture, { force: true });
  const env = {
    ...process.env,
    PATH: `${stub}:${process.env.PATH}`,
    DOCKER_TEST_CAPTURE: capture,
    DOCKER_TEST_EXIT: '0',
    REVIEW_TARGET: repo,
    REVIEW_OUTPUT_DIR: '',
    REVIEWER_DOCKER_IMAGE: 'reviewer:test',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ...extra,
  };
  let result;
  try {
    result = { code: 0, ...await run('sh', [script, ...args], { cwd: work, env }) };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.doesNotMatch(`${result.stdout ?? ''}${result.stderr ?? ''}`, /test-secret|test-token/);
  try {
    result.docker = JSON.parse(await readFile(capture, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return result;
}

test('Docker 機械審查保持離線唯讀，不傳入 AI 憑證', async (t) => {
  const result = await invoke(t, ['offline', '--base', 'HEAD', '--json'], {
    ANTHROPIC_API_KEY: 'test-secret',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.docker.includes('--read-only'));
  assert.equal(result.docker[result.docker.indexOf('--network') + 1], 'none');
  assert.ok(result.docker.includes(`${repo}:/target:ro`));
  assert.ok(result.docker.includes(`${repo}/.git:/git:ro`));
  assert.ok(result.docker.includes(`${repo}/.git:/target/.git:ro`));
  assert.ok(!result.docker.some((arg) => /ANTHROPIC|test-secret|test-token/.test(arg)));
  assert.deepEqual(result.docker.slice(-8), ['reviewer:test', 'node', 'bin/review.js', '--repo', '/target', '--base', 'HEAD', '--json']);
});

test('Docker AI 審查明確連網、只傳憑證名稱，預設仍唯讀', async (t) => {
  const result = await invoke(t, ['ai', '--base', 'HEAD'], {
    ANTHROPIC_API_KEY: 'test-secret',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.docker[result.docker.indexOf('--network') + 1], 'bridge');
  assert.ok(result.docker.includes(`${repo}:/target:ro`));
  assert.ok(result.docker.includes('ANTHROPIC_API_KEY'));
  assert.ok(result.docker.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(!result.docker.some((arg) => /test-secret|test-token/.test(arg)));
  assert.deepEqual(result.docker.slice(-8), ['reviewer:test', 'node', 'bin/review.js', '--repo', '/target', '--ai', '--base', 'HEAD']);
});

test('Docker AI 輸出到一般目錄但不套用修正時，目標仍唯讀、只傳憑證名稱', async (t) => {
  const output = join(work, 'ai-output');
  await mkdir(output);
  const result = await invoke(t, ['ai', '--base', 'HEAD', '--out', '/output/report.json'], {
    ANTHROPIC_API_KEY: 'test-secret',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    REVIEW_OUTPUT_DIR: output,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.docker[result.docker.indexOf('--network') + 1], 'bridge');
  assert.ok(result.docker.includes(`${repo}:/target:ro`));
  assert.ok(result.docker.includes(`${output}:/output:rw`));
  assert.ok(result.docker.includes('ANTHROPIC_API_KEY'));
  assert.ok(result.docker.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(!result.docker.some((arg) => /test-secret|test-token/.test(arg)));
});

test('離線輸出到一般目錄時仍不連網、不傳入憑證', async (t) => {
  const output = join(work, 'offline-output');
  await mkdir(output);
  const result = await invoke(t, ['offline', '--base', 'HEAD', '--out', '/output/report.json'], {
    ANTHROPIC_API_KEY: 'test-secret',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    REVIEW_OUTPUT_DIR: output,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.docker[result.docker.indexOf('--network') + 1], 'none');
  assert.ok(result.docker.includes(`${repo}:/target:ro`));
  assert.ok(result.docker.includes(`${output}:/output:rw`));
  assert.ok(!result.docker.some((arg) => /ANTHROPIC|test-secret|test-token/.test(arg)));
});

test('離線入口不會被位置參數 ai 切換成連網模式', async (t) => {
  const result = await invoke(t, ['offline', 'ai', '--base', 'HEAD'], { ANTHROPIC_API_KEY: 'test-secret' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.docker[result.docker.indexOf('--network') + 1], 'none');
  assert.ok(!result.docker.some((arg) => /ANTHROPIC|test-secret/.test(arg)));
  assert.ok(!result.docker.includes('--ai'));
});

test('沒有明確指定 offline 或 ai 模式時拒絕執行', async (t) => {
  for (const args of [['--base', 'HEAD'], ['AI', '--base', 'HEAD'], []]) {
    const result = await invoke(t, args, { ANTHROPIC_API_KEY: 'test-secret' });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /review:docker/);
    assert.equal(result.docker, undefined);
  }
});

test('npm script 明確指定 Docker 審查模式', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(scripts['review:docker'], /sh bin\/review-docker\.sh offline$/);
  assert.match(scripts['review:docker:ai'], /sh bin\/review-docker\.sh ai$/);
});

test('Docker AI 套用修正只開放目標寫入；linked worktree 的 Git metadata 仍唯讀，保留 CLI exit code', async (t) => {
  const output = join(work, 'output');
  await mkdir(output);
  const result = await invoke(t, ['ai', '--base', 'HEAD', '--ai-apply', '--fail-on-human', '--out', '/output/report.json'], {
    ANTHROPIC_API_KEY: 'test-secret',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    REVIEW_TARGET: linked,
    REVIEW_OUTPUT_DIR: output,
    DOCKER_TEST_EXIT: '1',
  });
  assert.equal(result.code, 1);
  assert.ok(result.docker.includes(`${linked}:/target:rw`));
  assert.ok(result.docker.includes(`${repo}/.git:/git:ro`));
  assert.ok(result.docker.includes(`${linked}/.git:/target/.git:ro`));
  assert.ok(result.docker.includes(`${output}:/output:rw`));
  assert.ok(result.docker.includes('GIT_DIR=/git/worktrees/linked'));
  assert.ok(result.docker.includes('ANTHROPIC_API_KEY'));
  assert.ok(result.docker.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(!result.docker.some((arg) => /test-secret|test-token/.test(arg)));
  assert.ok(result.docker.includes('--read-only'));
  assert.ok(result.docker.includes('--ai-apply'));
});

test('Docker AI 缺少憑證時立即失敗，不啟動容器', async (t) => {
  const result = await invoke(t, ['ai', '--base', 'HEAD']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/);
  assert.equal(result.docker, undefined);
});

test('離線入口拒絕 AI 旗標，不會默默忽略網路或寫入限制', async (t) => {
  for (const flag of ['--ai-apply', '--ai']) {
    const result = await invoke(t, ['offline', '--base', 'HEAD', flag]);
    assert.equal(result.code, 2, flag);
    assert.match(result.stderr, /review:docker:ai/);
    assert.equal(result.docker, undefined);
  }
});

test('Docker 入口拒絕無效目標與不存在的輸出目錄', async (t) => {
  const target = await invoke(t, ['offline', '--base', 'HEAD'], { REVIEW_TARGET: stub });
  assert.equal(target.code, 2);
  assert.match(target.stderr, /not a Git repository/);
  assert.equal(target.docker, undefined);
  const output = await invoke(t, ['offline', '--base', 'HEAD'], { REVIEW_OUTPUT_DIR: join(work, 'missing') });
  assert.equal(output.code, 2);
  assert.match(output.stderr, /does not exist/);
  assert.equal(output.docker, undefined);
});

test('輸出掛載不得以其他路徑重新開放 Git metadata 寫入', async (t) => {
  const gitlink = join(work, 'gitlink');
  await symlink(join(repo, '.git'), gitlink);
  for (const output of [repo, join(repo, '.git'), join(repo, '.git', 'hooks'), gitlink, work, linked, '/', '//']) {
    const result = await invoke(t, ['offline', '--base', 'HEAD'], { REVIEW_TARGET: linked, REVIEW_OUTPUT_DIR: output });
    assert.equal(result.code, 2, output);
    assert.match(result.stderr, /overlaps Git metadata/);
    assert.equal(result.docker, undefined);
  }
});

test('輸出目錄解析不受 CDPATH 與 cd - 影響，並拒絕含換行的路徑', async (t) => {
  const newline = join(work, 'line\nbreak');
  await mkdir(newline);
  // side/out 指向結尾是換行的實體目錄 x\n；同層的 x 是指向 .git 的 symlink，去掉換行就會落到它
  const side = join(work, 'side');
  await mkdir(join(side, 'x\n'), { recursive: true });
  await symlink(join(repo, '.git'), join(side, 'x'));
  await symlink('x\n', join(side, 'out'));
  const cases = [
    ['.git', { CDPATH: repo }, /does not exist/],
    ['-', { OLDPWD: join(repo, '.git') }],
    [newline, {}, /newline/],
    [join(side, 'out'), {}, /newline/],
    ['-', { OLDPWD: join(side, 'x\n') }],
  ];
  for (const [output, extra, stderr] of cases) {
    const result = await invoke(t, ['offline', '--base', 'HEAD'], { REVIEW_OUTPUT_DIR: output, ...extra });
    assert.equal(result.code, 2, JSON.stringify(output));
    if (stderr) assert.match(result.stderr, stderr);
    assert.equal(result.docker, undefined);
  }
});

test('以 root 執行 gate 時也驗證一般 UID 能載入 CLI 與 analyzer 依賴', { skip: process.getuid?.() !== 0 }, async () => {
  const cli = fileURLToPath(new URL('../../bin/reviewer.js', import.meta.url));
  const { stdout } = await run(process.execPath, [cli, 'doctor'], {
    cwd: '/', uid: 65534, gid: 65534, env: { PATH: process.env.PATH },
  });
  assert.doesNotMatch(stdout, /❌|⚠/);
});
