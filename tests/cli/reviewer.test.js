import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { isEntry } from '../../src/cli/entry.js';
import { PACKAGE_ROOT, diagnose, formatDiagnosis, packageVersion } from '../../src/cli/doctor.js';

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

test('reviewer：子指令與原本的 bin 相同（用法、exit code 都一樣），透過 symlink 執行時也只跑一次', async () => {
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

  // npm 安裝的指令是指向 bin 檔的 symlink：子指令只執行一次，直接執行原本的 bin 也仍然有效。
  const linkDir = join(work, 'bin');
  await mkdir(linkDir, { recursive: true });
  await symlink(REVIEWER, join(linkDir, 'reviewer'));
  await symlink(join(ROOT, 'bin', 'review.js'), join(linkDir, 'review'));
  const linked = await cli(join(linkDir, 'reviewer'), ['review', '--help']);
  assert.equal(linked.stdout.match(/用法：/g).length, 1);
  assert.match((await cli(join(linkDir, 'review'), ['--help'])).stdout, /^用法：reviewer review /);
});

test('isEntry：以 realpath 判斷入口；沒有入口或路徑不存在時為 false', async () => {
  const target = join(work, 'entry.mjs');
  await writeFile(target, '');
  const link = join(work, 'entry-link.mjs');
  await symlink(target, link);
  const url = pathToFileURL(target).href;
  assert.equal(isEntry(url, ['node', target]), true);
  assert.equal(isEntry(url, ['node', link]), true);
  assert.equal(isEntry(url, ['node', join(work, 'other.mjs')]), false);
  assert.equal(isEntry(url, ['node']), false);
  assert.equal(isEntry(url, ['node', '']), false);
  assert.equal(isEntry(pathToFileURL(join(work, 'missing.mjs')).href, ['node', join(work, 'missing.mjs')]), false);
});

test('doctor：缺少 git 或 typescript 為錯誤；PHP 與 PHP analyzer 依賴只警告並印出安裝方式；不顯示 key 的內容', async () => {
  const fakeExec = (outputs) => async (command) => outputs[command] ?? null;
  const levels = (checks) => Object.fromEntries(checks.map(({ label, level }) => [label, level]));

  // 這個 repo：typescript 由 npm 安裝。
  const real = await diagnose({ exec: fakeExec({ git: 'git version 2.43.0', php: '8.4.1' }), env: { ANTHROPIC_API_KEY: 'sk-secret' } });
  assert.equal(levels(real)['TS/JS analyzer'], 'ok');
  assert.equal(real.find((check) => check.label === 'git').detail, '2.43.0');
  assert.equal(levels(real).PHP, 'ok');
  const text = formatDiagnosis(real, { version: '9.9.9', root: '/opt/reviewer' });
  assert.match(text, /^reviewer 9\.9\.9（\/opt\/reviewer）/);
  assert.match(text, /ANTHROPIC_API_KEY：已設定/);
  assert.match(text, /REVIEWER_STATE_KEY：未設定/);
  assert.doesNotMatch(text, /sk-secret/);

  // 空的目錄：找不到 typescript、沒有 PHP analyzer 依賴；沒有 git、PHP 太舊或沒有 PHP。
  const empty = join(work, 'empty-root');
  await mkdir(join(empty, 'analyzers', 'ts', 'bin'), { recursive: true });
  for (const [php, phpDetail] of [[null, /找不到 php/], ['8.2.10', /8\.2\.10 低於 8\.3/], ['7.4', /低於 8\.3/], ['8.3.0', /^8\.3\.0$/], ['9.0.0', /^9\.0\.0$/]]) {
    const checks = await diagnose({ root: empty, exec: fakeExec({ php }), env: {} });
    const byLabel = Object.fromEntries(checks.map((check) => [check.label, check]));
    assert.equal(byLabel.git.level, 'error');
    assert.equal(byLabel['TS/JS analyzer'].level, 'error');
    assert.match(byLabel.PHP.detail, phpDetail, String(php));
    assert.equal(byLabel.PHP.level, /低於|找不到/.test(byLabel.PHP.detail) ? 'warn' : 'ok', String(php));
    assert.equal(byLabel['PHP analyzer 依賴'].level, 'warn');
    assert.equal(byLabel['PHP analyzer 依賴'].fix, `composer install --working-dir="${join(empty, 'analyzers', 'php')}" --no-interaction`);
  }
  assert.match(formatDiagnosis(await diagnose({ root: empty, exec: fakeExec({}), env: {} }), { version: '1', root: empty }), /❌ git：找不到 git\n {3}安裝 git/);

  // 實際執行：輸出 reviewer 的版本與目錄；exit code 依有沒有錯誤。
  const doctor = await cli(REVIEWER, ['doctor']);
  assert.match(doctor.stdout, new RegExp(`^reviewer ${version.replaceAll('.', '\\.')}（`));
  assert.ok(doctor.stdout.includes(PACKAGE_ROOT));
  assert.equal(doctor.code, /❌/.test(doctor.stdout) ? 1 : 0);
  assert.match((await cli(REVIEWER, ['doctor', '--help'])).stdout, /^用法：reviewer doctor/);
});

test('套件內容：包含執行所需的檔案，不包含測試、evaluation、fixtures 與 PHP analyzer 的 vendor', async () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await run(npm, ['pack', '--dry-run', '--json'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map(({ path }) => path));
  for (const required of [
    'package.json', 'bin/reviewer.js', 'bin/review.js', 'bin/review-state.js', 'bin/retro.js',
    'src/cli/doctor.js', 'src/review/review.js', 'src/storage/schema.sql',
    'analyzers/php/bin/analyze.php', 'analyzers/php/composer.json', 'analyzers/php/composer.lock',
    'analyzers/ts/bin/analyze.js', 'analyzers/ts/src/analyze.js',
  ]) {
    assert.ok(files.has(required), required);
  }
  const unexpected = [...files].filter((path) => /^(tests|evaluation|fixtures|docs|coverage|node_modules)\/|^analyzers\/php\/vendor\//.test(path));
  assert.deepEqual(unexpected, []);

  // 沒有 prepare：npm 全域從 git 安裝有 prepare 的套件時，會留下指向已刪除暫存 clone 的 symlink。
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prepare, undefined);
  assert.deepEqual(pkg.bin, { reviewer: 'bin/reviewer.js' });
});
