import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * `reviewer doctor`：檢查執行環境，並在缺少時說明怎麼安裝。
 *
 * - git 與 TS/JS analyzer 的 `typescript`（npm 依賴，安裝 reviewer 時自動裝好）缺少時 exit 1。
 * - PHP 與 PHP analyzer 的依賴（`nikic/php-parser`，不隨套件提供，要自己 `composer install`）只有 PHP 檔需要：
 *   缺少時只警告，PHP 檔會判為完整 review（fail-closed）。
 * - API key 只顯示有沒有設定，不顯示內容。
 */

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const MIN_PHP = Object.freeze([8, 3]);

/**
 * 執行指令並取得 stdout（失敗時為 null）。
 *
 * @param {string} command - 指令。
 * @param {string[]} args - 參數。
 * @returns {Promise<string|null>} stdout。
 */
function execText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/**
 * TS/JS analyzer 解析到的 `typescript` 版本。analyzer 以 ESM `import` 載入，只從 analyzer 所在目錄往上找
 * `node_modules`（不看 `NODE_PATH` 與全域目錄），這裡以相同的方式找。
 *
 * @param {string} root - reviewer 的目錄。
 * @returns {string|null} 版本；找不到時為 null。
 */
function typescriptVersion(root) {
  let dir = join(root, 'analyzers', 'ts', 'bin');
  for (;;) {
    try {
      return JSON.parse(readFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')).version ?? null;
    } catch {
      // 這一層沒有：往上一層找。
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * PHP 版本是否至少為 MIN_PHP。
 *
 * @param {string} version - 例如 `8.3.6`。
 * @returns {boolean} 是否足夠。
 */
function phpSupported(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_PHP[0] || (major === MIN_PHP[0] && minor >= MIN_PHP[1]);
}

/**
 * 檢查執行環境。
 *
 * @param {object} [options={}] - 選項（測試用）。
 * @param {string} [options.root=PACKAGE_ROOT] - reviewer 的目錄。
 * @param {Function} [options.exec] - `(command, args) => Promise<string|null>`。
 * @param {object} [options.env=process.env] - 環境變數。
 * @returns {Promise<Array<{level: 'ok'|'error'|'warn'|'info', label: string, detail: string, fix?: string}>>} 檢查結果。
 */
export async function diagnose({ root = PACKAGE_ROOT, exec = execText, env = process.env } = {}) {
  const checks = [{ level: 'ok', label: 'Node.js', detail: process.version }];
  const [git, php] = await Promise.all([exec('git', ['--version']), exec('php', ['-r', 'echo PHP_VERSION;'])]);
  checks.push(git
    ? { level: 'ok', label: 'git', detail: git.replace(/^git version\s*/, '') }
    : { level: 'error', label: 'git', detail: '找不到 git', fix: '安裝 git，並放在 PATH 上' });

  const ts = typescriptVersion(root);
  checks.push(ts
    ? { level: 'ok', label: 'TS/JS analyzer', detail: `typescript ${ts}` }
    : { level: 'error', label: 'TS/JS analyzer', detail: '找不到 typescript（TS/JS 檔會判為完整 review）', fix: `在 ${root} 執行 npm install，或重新安裝 reviewer` });

  const phpOk = typeof php === 'string' && /^\d+\.\d+/.test(php) && phpSupported(php);
  let phpCheck = { level: 'ok', label: 'PHP', detail: php };
  if (!php) phpCheck = { level: 'warn', label: 'PHP', detail: '找不到 php（PHP 檔會判為完整 review）', fix: `安裝 PHP ${MIN_PHP.join('.')} 以上，並放在 PATH 上` };
  else if (!phpOk) phpCheck = { level: 'warn', label: 'PHP', detail: `${php} 低於 ${MIN_PHP.join('.')}（PHP 檔會判為完整 review）`, fix: `安裝 PHP ${MIN_PHP.join('.')} 以上` };
  checks.push(phpCheck);

  const phpDir = join(root, 'analyzers', 'php');
  checks.push(existsSync(join(phpDir, 'vendor', 'autoload.php'))
    ? { level: 'ok', label: 'PHP analyzer 依賴', detail: '已安裝' }
    : { level: 'warn', label: 'PHP analyzer 依賴', detail: '沒有安裝（PHP 檔會判為完整 review）', fix: `composer install --working-dir="${phpDir}" --no-interaction` });

  const present = (name) => typeof env[name] === 'string' && env[name] !== '';
  checks.push({ level: 'info', label: 'ANTHROPIC_API_KEY', detail: `${present('ANTHROPIC_API_KEY') ? '已設定' : '未設定'}（只有 --ai 需要）` });
  checks.push({ level: 'info', label: 'REVIEWER_STATE_KEY', detail: `${present('REVIEWER_STATE_KEY') ? '已設定' : '未設定'}（只有 reviewer state 需要）` });
  return checks;
}

const MARKS = Object.freeze({ ok: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' });

/**
 * 檢查結果的文字輸出。
 *
 * @param {object[]} checks - diagnose() 的結果。
 * @param {{version: string, root: string}} about - reviewer 的版本與目錄。
 * @returns {string} 文字。
 */
export function formatDiagnosis(checks, { version, root }) {
  const lines = [`reviewer ${version}（${root}）`];
  for (const check of checks) {
    lines.push(`${MARKS[check.level]} ${check.label}：${check.detail}`);
    if (check.fix) lines.push(`   ${check.fix}`);
  }
  return lines.join('\n');
}

/**
 * reviewer 的版本（package.json）。
 *
 * @param {string} [root=PACKAGE_ROOT] - reviewer 的目錄。
 * @returns {string} 版本。
 */
export function packageVersion(root = PACKAGE_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

const USAGE = `用法：reviewer doctor

檢查執行環境：git、TS/JS analyzer 的 typescript、PHP 與 PHP analyzer 的依賴，以及 API key 有沒有設定。
缺少時印出安裝方式。PHP analyzer 的依賴不隨套件提供，需要的人自己以 composer 安裝。

exit code：0 可以執行（PHP 相關只警告）；1 缺少 git 或 typescript。`;

/**
 * 執行 `reviewer doctor`。
 *
 * @param {string[]} args - 參數（不含指令名稱）。
 * @returns {Promise<void>} 完成；結果以 stdout 與 `process.exitCode` 表示。
 */
export async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const checks = await diagnose();
  process.stdout.write(`${formatDiagnosis(checks, { version: packageVersion(), root: PACKAGE_ROOT })}\n`);
  if (checks.some((check) => check.level === 'error')) process.exitCode = 1;
}
