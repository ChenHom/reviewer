import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * `reviewer doctor`：檢查執行環境，並在缺少時說明怎麼安裝。
 *
 * - Node.js 低於 `package.json` 的 `engines.node`、沒有 git、找不到或版本不是鎖定的 `typescript`（npm 依賴，
 *   安裝 reviewer 時自動裝好）時 exit 1。
 * - PHP 與 PHP analyzer 的依賴（`nikic/php-parser`，不隨套件提供，要自己 `composer install`）只有 PHP 檔需要：
 *   缺少時只警告，PHP 檔會判為完整 review（fail-closed）。PHP 的最低版本取自 `analyzers/php/composer.json`。
 * - API key 只顯示有沒有設定，不顯示內容。
 */

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * 執行指令並取得 stdout（失敗時為 null）。
 *
 * @param {string} command - 指令。
 * @param {string[]} args - 參數。
 * @returns {Promise<string|null>} stdout。
 */
function execText(command, args) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => resolvePromise(error ? null : stdout.trim()));
  });
}

/**
 * 讀取 JSON 檔（不存在或無法解析時為 null）。
 *
 * @param {string} path - 路徑。
 * @returns {object|null} 內容。
 */
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `>=8.3`、`>=18.14` 這類下限需求的最低版本。其他寫法（`^`、`||`、範圍）無法判斷，為 null。
 *
 * @param {unknown} constraint - 版本需求。
 * @returns {number[]|null} 例如 `[8, 3, 0]`。
 */
export function minimumVersion(constraint) {
  const match = /^\s*>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(String(constraint ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/**
 * 版本是否至少為 minimum（只比較開頭的數字，`v22.1.0`、`8.3.6-1ubuntu` 都可以）。
 *
 * @param {string} version - 版本。
 * @param {number[]} minimum - minimumVersion() 的結果。
 * @returns {boolean} 是否足夠。
 */
export function versionAtLeast(version, minimum) {
  const parts = String(version).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
  for (const [index, required] of minimum.entries()) {
    const value = Number.isInteger(parts[index]) ? parts[index] : 0;
    if (value !== required) return value > required;
  }
  return true;
}

/**
 * TS/JS analyzer 會載入的 `typescript`。analyzer 以 ESM `import` 載入，只從 analyzer 所在目錄往上找
 * `node_modules`（不看 `NODE_PATH` 與全域目錄），這裡以相同的方式找。
 *
 * @param {string} root - reviewer 的目錄。
 * @returns {{version: string|null, dir: string}|null} 版本與所在目錄；找不到時為 null。
 */
export function findTypescript(root) {
  let dir = join(root, 'analyzers', 'ts', 'bin');
  for (;;) {
    const candidate = join(dir, 'node_modules', 'typescript');
    const manifest = readJsonFile(join(candidate, 'package.json'));
    if (manifest) return { version: typeof manifest.version === 'string' ? manifest.version : null, dir: candidate };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 重新安裝依賴的方式：reviewer 的 checkout 有 `package-lock.json`（套件不含它）。
 *
 * @param {string} root - reviewer 的目錄。
 * @returns {string} 說明。
 */
function reinstallHint(root) {
  return existsSync(join(root, 'package-lock.json'))
    ? `在 ${root} 執行 npm ci`
    : '重新安裝 reviewer（例如 npm i -g github:ChenHom/reviewer）';
}

/**
 * Node.js 的版本是否符合 `package.json` 的 `engines.node`。
 *
 * @param {object|null} manifest - reviewer 的 package.json。
 * @param {string} nodeVersion - 目前的 Node.js 版本。
 * @returns {object} 檢查結果。
 */
function nodeCheck(manifest, nodeVersion) {
  const minimum = minimumVersion(manifest?.engines?.node);
  if (!minimum) return { level: 'warn', label: 'Node.js', detail: `${nodeVersion}（無法判斷需求：package.json 的 engines.node）` };
  if (versionAtLeast(nodeVersion, minimum)) return { level: 'ok', label: 'Node.js', detail: nodeVersion };
  return { level: 'error', label: 'Node.js', detail: `${nodeVersion} 低於 ${minimum.join('.')}`, fix: `安裝 Node.js ${minimum.join('.')} 以上` };
}

/**
 * TS/JS analyzer 的 `typescript`：要找得到，而且是 `package.json` 鎖定的版本（其他版本的分析結果未經驗證）。
 *
 * @param {string} root - reviewer 的目錄。
 * @param {object|null} manifest - reviewer 的 package.json。
 * @param {Function} find - findTypescript()。
 * @returns {object} 檢查結果。
 */
function typescriptCheck(root, manifest, find) {
  const label = 'TS/JS analyzer';
  const found = find(root);
  if (!found) return { level: 'error', label, detail: '找不到 typescript（TS/JS 檔會判為完整 review）', fix: reinstallHint(root) };
  const pinned = manifest?.dependencies?.typescript;
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned) || found.version === pinned) {
    return { level: 'ok', label, detail: `typescript ${found.version}` };
  }
  // 舊版的安裝方式（`npm ci --prefix analyzers/ts`）留下的目錄離 analyzer 比較近，會優先被載入。
  const leftover = found.dir.startsWith(join(root, 'analyzers') + sep);
  return {
    level: 'error',
    label,
    detail: `typescript ${found.version}（${found.dir}），需要 ${pinned}（TS/JS 檔的分析結果未經驗證）`,
    fix: leftover ? `刪除舊版安裝留下的 ${dirname(found.dir)}` : reinstallHint(root),
  };
}

/**
 * PHP 的版本是否符合 PHP analyzer 的 `composer.json`（`require.php`）。
 *
 * @param {string|null} php - `php` 回報的版本；找不到 php 時為 null。
 * @param {object|null} composer - PHP analyzer 的 composer.json。
 * @returns {object} 檢查結果。
 */
function phpCheck(php, composer) {
  const minimum = minimumVersion(composer?.require?.php);
  const required = minimum ? `PHP ${minimum.slice(0, 2).join('.')} 以上` : 'PHP';
  if (!php) return { level: 'warn', label: 'PHP', detail: '找不到 php（PHP 檔會判為完整 review）', fix: `安裝 ${required}，並放在 PATH 上` };
  if (!minimum) return { level: 'warn', label: 'PHP', detail: `${php}（無法判斷需求：analyzers/php/composer.json 的 require.php）` };
  if (/^\d+\.\d+/.test(php) && versionAtLeast(php, minimum)) return { level: 'ok', label: 'PHP', detail: php };
  return { level: 'warn', label: 'PHP', detail: `${php} 不符合需求（PHP 檔會判為完整 review）`, fix: `安裝 ${required}` };
}

/**
 * 檢查執行環境。
 *
 * @param {object} [options={}] - 選項（測試用）。
 * @param {string} [options.root=PACKAGE_ROOT] - reviewer 的目錄。
 * @param {Function} [options.exec] - `(command, args) => Promise<string|null>`。
 * @param {object} [options.env=process.env] - 環境變數。
 * @param {string} [options.nodeVersion=process.version] - Node.js 的版本。
 * @param {Function} [options.find=findTypescript] - 找 `typescript` 的方式。
 * @returns {Promise<Array<{level: 'ok'|'error'|'warn'|'info', label: string, detail: string, fix?: string}>>} 檢查結果。
 */
export async function diagnose({ root = PACKAGE_ROOT, exec = execText, env = process.env, nodeVersion = process.version, find = findTypescript } = {}) {
  const manifest = readJsonFile(join(root, 'package.json'));
  const phpDir = join(root, 'analyzers', 'php');
  const [git, php] = await Promise.all([exec('git', ['--version']), exec('php', ['-r', 'echo PHP_VERSION;'])]);
  const present = (name) => typeof env[name] === 'string' && env[name] !== '';
  return [
    nodeCheck(manifest, nodeVersion),
    git
      ? { level: 'ok', label: 'git', detail: git.replace(/^git version\s*/, '') }
      : { level: 'error', label: 'git', detail: '找不到 git', fix: '安裝 git，並放在 PATH 上' },
    typescriptCheck(root, manifest, find),
    phpCheck(php, readJsonFile(join(phpDir, 'composer.json'))),
    existsSync(join(phpDir, 'vendor', 'autoload.php'))
      ? { level: 'ok', label: 'PHP analyzer 依賴', detail: '已安裝' }
      : { level: 'warn', label: 'PHP analyzer 依賴', detail: '沒有安裝（PHP 檔會判為完整 review）', fix: `composer install --working-dir="${phpDir}" --no-interaction` },
    { level: 'info', label: 'ANTHROPIC_API_KEY', detail: `${present('ANTHROPIC_API_KEY') ? '已設定' : '未設定'}（只有 --ai 需要）` },
    { level: 'info', label: 'REVIEWER_STATE_KEY', detail: `${present('REVIEWER_STATE_KEY') ? '已設定' : '未設定'}（只有 reviewer state 需要）` },
  ];
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

檢查執行環境：Node.js、git、TS/JS analyzer 的 typescript、PHP 與 PHP analyzer 的依賴，以及 API key 有沒有設定。
缺少時印出安裝方式。PHP analyzer 的依賴不隨套件提供，需要的人自己以 composer 安裝。

exit code：0 可以執行（PHP 相關只警告）；1 Node.js 版本不足、沒有 git，或找不到鎖定版本的 typescript；2 參數錯誤。`;

/**
 * 執行 `reviewer doctor`。
 *
 * @param {string[]} args - 參數（不含指令名稱）。
 * @returns {Promise<void>} 完成；結果以 stdout、stderr 與 `process.exitCode` 表示。
 */
export async function run(args) {
  try {
    const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const checks = await diagnose();
  process.stdout.write(`${formatDiagnosis(checks, { version: packageVersion(), root: PACKAGE_ROOT })}\n`);
  if (checks.some((check) => check.level === 'error')) process.exitCode = 1;
}
