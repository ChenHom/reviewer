import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PACKAGE_ROOT, diagnose, findTypescript, formatDiagnosis, minimumVersion, packageVersion, versionAtLeast } from '../../src/cli/doctor.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REVIEWER = join(ROOT, 'bin', 'reviewer.js');
const work = await mkdtemp(join(tmpdir(), 'reviewer-cli-'));
after(() => rm(work, { recursive: true, force: true }));
const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

/**
 * 執行指令，回傳 exit code、stdout 與 stderr（非 0 也不丟例外）。
 *
 * @param {string} script - 腳本路徑。
 * @param {string[]} args - 參數。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 結果。
 */
async function cli(script, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { env: { PATH: process.env.PATH } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('reviewer：--version、--help；沒有指令或指令不認得時 exit 2', async () => {
  assert.deepEqual(await cli(REVIEWER, ['--version']), { code: 0, stdout: `${version}\n`, stderr: '' });
  assert.equal(packageVersion(), version);
  const help = await cli(REVIEWER, ['--help']);
  assert.equal(help.code, 0);
  for (const command of ['review', 'state', 'retro', 'doctor']) assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'));

  const empty = await cli(REVIEWER, []);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /用法：reviewer <指令>/);
  // 不能以 prototype 上的名稱呼叫。
  for (const name of ['nope', 'constructor', '__proto__']) {
    const unknown = await cli(REVIEWER, [name]);
    assert.equal(unknown.code, 2, name);
    assert.match(unknown.stderr, new RegExp(`COMMAND_UNKNOWN:${name}`), name);
  }
});

test('reviewer：子指令與原本的 bin 相同；透過 symlink 或不加 .js 執行時都會執行（不會靜默以 0 結束）', async () => {
  for (const [command, script] of [['review', 'review.js'], ['state', 'review-state.js'], ['retro', 'retro.js']]) {
    const viaReviewer = await cli(REVIEWER, [command, '--help']);
    const direct = await cli(join(ROOT, 'bin', script), ['--help']);
    assert.equal(viaReviewer.code, 0, command);
    assert.equal(viaReviewer.stdout, direct.stdout, command);
    assert.match(viaReviewer.stdout, new RegExp(`^用法：reviewer ${command} `), command);
  }
  // 參數錯誤時的 exit code 與訊息也相同。
  const missing = await cli(REVIEWER, ['state', '--pr', 'x.json']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /OPTION_MISSING:--report/);
  assert.match((await cli(REVIEWER, ['review'])).stderr, /OPTION_MISSING:--base/);

  // `node bin/review`（Node 會補上 .js）：gate 不能因為沒有執行而通過。
  for (const [script, args, pattern] of [
    ['review', ['--base', 'nonexistent-ref', '--fail-on-human'], /GIT_FAILED/],
    ['review-state', ['--pr', 'x.json'], /OPTION_MISSING:--report/],
    ['retro', [], /RETRO_|OPTION_MISSING/],
  ]) {
    const result = await cli(join(ROOT, 'bin', script), args);
    assert.equal(result.code, 2, script);
    assert.match(result.stderr, pattern, script);
  }

  // npm 安裝的指令是指向 bin 檔的 symlink：子指令只執行一次，直接執行原本的 bin 也仍然有效。
  const linkDir = join(work, 'bin');
  await mkdir(linkDir, { recursive: true });
  await symlink(REVIEWER, join(linkDir, 'reviewer'));
  await symlink(join(ROOT, 'bin', 'review.js'), join(linkDir, 'review'));
  const linked = await cli(join(linkDir, 'reviewer'), ['review', '--help']);
  assert.equal(linked.stdout.match(/用法：/g).length, 1);
  assert.match((await cli(join(linkDir, 'review'), ['--help'])).stdout, /^用法：reviewer review /);
});

test('minimumVersion 與 versionAtLeast：只認 >= 下限；比較開頭的數字', () => {
  assert.deepEqual(minimumVersion('>=8.3'), [8, 3, 0]);
  assert.deepEqual(minimumVersion(' >= 18.14.1 '), [18, 14, 1]);
  for (const constraint of ['^8.3', '>=8', '>=8.3 <9', '8.3', undefined, null]) assert.equal(minimumVersion(constraint), null, String(constraint));
  assert.equal(versionAtLeast('v18.14.0', [18, 14, 0]), true);
  assert.equal(versionAtLeast('v18.13.9', [18, 14, 0]), false);
  assert.equal(versionAtLeast('8.3.6-1ubuntu', [8, 3, 0]), true);
  assert.equal(versionAtLeast('9.0', [8, 3, 0]), true);
  assert.equal(versionAtLeast('8.2.99', [8, 3, 0]), false);
});

test('doctor：Node.js 版本不足、沒有 git、typescript 找不到或不是鎖定版本時為錯誤；PHP 相關只警告；不顯示 key 的內容', async () => {
  const fakeExec = (outputs) => async (command) => outputs[command] ?? null;
  const byLabel = (checks) => Object.fromEntries(checks.map((check) => [check.label, check]));
  /**
   * 建立假的 reviewer 目錄。
   *
   * @param {string} name - 目錄名稱。
   * @param {object} [options] - package.json 與 composer.json 的內容。
   * @returns {Promise<string>} 路徑。
   */
  const fakeRoot = async (name, { engines = '>=18.14', php = '>=8.3', lock = true } = {}) => {
    const root = join(work, name);
    await mkdir(join(root, 'analyzers', 'ts', 'bin'), { recursive: true });
    await mkdir(join(root, 'analyzers', 'php'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.0.1', engines: engines ? { node: engines } : undefined, dependencies: { typescript: '5.9.3' } }));
    await writeFile(join(root, 'analyzers', 'php', 'composer.json'), JSON.stringify({ require: { php } }));
    if (lock) await writeFile(join(root, 'package-lock.json'), '{}');
    return root;
  };
  const found = (dir, tsVersion = '5.9.3') => () => ({ version: tsVersion, dir });
  const root = await fakeRoot('fake');
  const base = { root, exec: fakeExec({ git: 'git version 2.43.0', php: '8.4.1' }), env: {}, nodeVersion: 'v22.1.0', find: found('/x/node_modules/typescript') };

  const healthy = await diagnose({ ...base, env: { ANTHROPIC_API_KEY: 'sk-secret' } });
  const checks = byLabel(healthy);
  assert.deepEqual(['Node.js', 'git', 'TS/JS analyzer', 'PHP'].map((label) => checks[label].level), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(checks.git.detail, '2.43.0');
  assert.equal(checks['PHP analyzer 依賴'].level, 'warn');
  assert.equal(checks['PHP analyzer 依賴'].fix, `composer install --working-dir="${join(root, 'analyzers', 'php')}" --no-interaction`);
  const text = formatDiagnosis(healthy, { version: '9.9.9', root: '/opt/reviewer' });
  assert.match(text, /^reviewer 9\.9\.9（\/opt\/reviewer）/);
  assert.match(text, /ANTHROPIC_API_KEY：已設定/);
  assert.match(text, /REVIEWER_STATE_KEY：未設定/);
  assert.doesNotMatch(text, /sk-secret/);

  // Node.js：以 package.json 的 engines.node 判斷；無法判斷時警告。
  for (const [nodeVersion, level] of [['v18.13.0', 'error'], ['v18.14.0', 'ok'], ['v24.0.0', 'ok']]) {
    assert.equal(byLabel(await diagnose({ ...base, nodeVersion }))['Node.js'].level, level, nodeVersion);
  }
  const old = byLabel(await diagnose({ ...base, nodeVersion: 'v16.20.0' }))['Node.js'];
  assert.deepEqual([old.detail, old.fix], ['v16.20.0 低於 18.14.0', '安裝 Node.js 18.14.0 以上']);
  assert.equal(byLabel(await diagnose({ ...base, root: await fakeRoot('no-engines', { engines: null }) }))['Node.js'].level, 'warn');

  // git。
  const noGit = byLabel(await diagnose({ ...base, exec: fakeExec({ php: '8.4.1' }) })).git;
  assert.deepEqual([noGit.level, noGit.fix], ['error', '安裝 git，並放在 PATH 上']);

  // typescript：找不到時，checkout（有 package-lock.json）建議 npm ci，安裝的套件建議重新安裝。
  const missingTs = byLabel(await diagnose({ ...base, find: () => null }))['TS/JS analyzer'];
  assert.deepEqual([missingTs.level, missingTs.fix], ['error', `在 ${root} 執行 npm ci`]);
  const installed = await fakeRoot('installed', { lock: false });
  assert.match(byLabel(await diagnose({ ...base, root: installed, find: () => null }))['TS/JS analyzer'].fix, /^重新安裝 reviewer/);
  // 版本不是鎖定的 5.9.3：舊版安裝留下的 analyzers/ts/node_modules 建議刪除，其他建議重新安裝。
  const leftoverDir = join(root, 'analyzers', 'ts', 'node_modules', 'typescript');
  const leftover = byLabel(await diagnose({ ...base, find: found(leftoverDir, '5.4.0') }))['TS/JS analyzer'];
  assert.equal(leftover.level, 'error');
  assert.match(leftover.detail, /typescript 5\.4\.0（.*），需要 5\.9\.3/);
  assert.equal(leftover.fix, `刪除舊版安裝留下的 ${join(root, 'analyzers', 'ts', 'node_modules')}`);
  assert.equal(byLabel(await diagnose({ ...base, find: found('/project/node_modules/typescript', '5.4.0') }))['TS/JS analyzer'].fix, `在 ${root} 執行 npm ci`);

  // findTypescript：以 analyzer 的位置往上找，離 analyzer 最近的優先。
  await mkdir(join(root, 'node_modules', 'typescript'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'typescript', 'package.json'), '{"version":"5.9.3"}');
  assert.deepEqual(findTypescript(root), { version: '5.9.3', dir: join(root, 'node_modules', 'typescript') });
  await mkdir(leftoverDir, { recursive: true });
  await writeFile(join(leftoverDir, 'package.json'), '{"version":"5.4.0"}');
  assert.deepEqual(findTypescript(root), { version: '5.4.0', dir: leftoverDir });

  // PHP：最低版本取自 composer.json；找不到、版本不足或無法判斷需求時警告。
  for (const [php, level, detail] of [
    [null, 'warn', /找不到 php/], ['8.2.10', 'warn', /8\.2\.10 不符合需求/], ['7.4', 'warn', /不符合需求/],
    ['8.3.0', 'ok', /^8\.3\.0$/], ['9.0.0', 'ok', /^9\.0\.0$/], ['8.3.6-1ubuntu', 'ok', /^8\.3\.6-1ubuntu$/],
  ]) {
    const check = byLabel(await diagnose({ ...base, exec: fakeExec({ git: 'git version 2', php }) })).PHP;
    assert.equal(check.level, level, String(php));
    assert.match(check.detail, detail, String(php));
  }
  assert.equal(byLabel(await diagnose({ ...base, exec: fakeExec({ git: 'git version 2' }) })).PHP.fix, '安裝 PHP 8.3 以上，並放在 PATH 上');
  const caret = byLabel(await diagnose({ ...base, root: await fakeRoot('caret', { php: '^8.3' }) })).PHP;
  assert.equal(caret.level, 'warn');
  assert.match(caret.detail, /無法判斷需求/);
});

test('doctor 的 CLI：輸出版本與目錄，exit code 依有沒有錯誤；不認得的參數 exit 2', async () => {
  const doctor = await cli(REVIEWER, ['doctor']);
  assert.match(doctor.stdout, new RegExp(`^reviewer ${version.replaceAll('.', '\\.')}（`));
  assert.ok(doctor.stdout.includes(PACKAGE_ROOT));
  assert.equal(doctor.code, /❌/.test(doctor.stdout) ? 1 : 0);
  assert.match((await cli(REVIEWER, ['doctor', '--help'])).stdout, /^用法：reviewer doctor/);
  const unknown = await cli(REVIEWER, ['doctor', '--json']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /--json/);
});

test('套件：打包後的內容可以直接執行（review 的 TS / PHP analyzer、state、retro、doctor），不含測試與 PHP analyzer 的 vendor', async () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const dest = join(work, 'pack');
  await mkdir(dest, { recursive: true });
  const { stdout } = await run(npm, ['pack', '--json', '--pack-destination', dest], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  const [info] = JSON.parse(stdout);
  const files = info.files.map(({ path }) => path);
  assert.deepEqual(files.filter((path) => /^(tests|evaluation|fixtures|docs|coverage|node_modules)\/|^analyzers\/php\/vendor\//.test(path)), []);

  // 套件名稱是自己的 scope（`reviewer` 在 npm 上是別人的套件）；沒有 prepare（npm 全域從 git 安裝有 prepare 的套件時，
  // 會留下指向已刪除暫存 clone 的 symlink）。
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@chenhom/reviewer');
  assert.deepEqual(pkg.bin, { reviewer: 'bin/reviewer.js' });
  assert.equal(pkg.scripts.prepare, undefined);

  // 解開套件，依賴以 repo 的 node_modules 與複製的 vendor 代替 npm / composer 安裝（vendor 用複製的：
  // Composer 的 autoload 以 vendor 的實際位置找 analyzer 的 src，symlink 會載入 repo 的 src）。
  const extracted = join(work, 'extracted');
  await mkdir(extracted, { recursive: true });
  await run('tar', ['-xzf', join(dest, info.filename), '-C', extracted]);
  const pkgDir = join(extracted, 'package');
  await symlink(join(ROOT, 'node_modules'), join(pkgDir, 'node_modules'), 'dir');
  await cp(join(ROOT, 'analyzers', 'php', 'vendor'), join(pkgDir, 'analyzers', 'php', 'vendor'), { recursive: true });
  const bin = join(pkgDir, 'bin', 'reviewer.js');

  // 只改註解的 TS 與 PHP 檔：兩個 analyzer 都要能執行，才會判為不需要 review。
  const repo = join(work, 'project');
  await mkdir(repo, { recursive: true });
  const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
  await git('init', '-q');
  await writeFile(join(repo, 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  await writeFile(join(repo, 'Order.php'), '<?php\n\nfunction total($a, $b)\n{\n    return $a + $b;\n}\n');
  await git('add', '-A');
  await git('commit', '-qm', 'base');
  await git('branch', '-M', 'main');
  await git('checkout', '-qb', 'feature');
  await writeFile(join(repo, 'util.ts'), 'export function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n');
  await writeFile(join(repo, 'Order.php'), '<?php\n\nfunction total($a, $b)\n{\n    // sum\n    return $a + $b;\n}\n');
  await git('commit', '-qam', 'comments');

  const review = await cli(bin, ['review', '--repo', repo, '--base', 'main', '--json']);
  assert.equal(review.code, 0, review.stderr);
  const report = JSON.parse(review.stdout);
  assert.deepEqual(report.files.map(({ path, decision, reasons }) => [path, decision, reasons]), [
    ['Order.php', 'NOT_SELECTED_FOR_HUMAN_REVIEW', ['NO_REDUCTION_BLOCKER']],
    ['util.ts', 'NOT_SELECTED_FOR_HUMAN_REVIEW', ['NO_REDUCTION_BLOCKER']],
  ]);
  for (const command of ['state', 'retro', 'doctor']) {
    const help = await cli(bin, [command, '--help']);
    assert.equal(help.code, 0, `${command}: ${help.stderr}`);
    assert.match(help.stdout, new RegExp(`^用法：reviewer ${command}`), command);
  }
  assert.equal((await cli(bin, ['--version'])).stdout, `${version}\n`);
});
