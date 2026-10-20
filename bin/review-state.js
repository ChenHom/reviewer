#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { isEntry } from '../src/cli/entry.js';
import { loadReports } from '../src/retro/metrics.js';
import { stateKeys } from '../src/review-state/codec.js';
import { ACK_PERMISSIONS, updateReviewState } from '../src/review-state/index.js';

const USAGE = `用法：reviewer state --report <file> --pr <file> [options]
（在 reviewer 的 checkout 中也可以執行 node bin/review-state.js）

二次 review 的狀態更新：以目前 head 的報表重算單向門與人工確認的狀態，輸出置頂儀表板、Check、
確認指令（/reviewer ack）的回覆與行內 thread 的目標狀態。不呼叫 GitHub API，寫回 PR 由 workflow 負責。

  --report <file>          目前 head 的報表（reviewer review --out）
  --pr <file>              PR（GitHub REST 的 pull request JSON：number、user.login、head.sha）；
                           head.sha 與報表不同時拒絕執行（REVIEW_STATE_STALE_REPORT）
  --dashboard <file>       上一版儀表板留言：GitHub 留言的 JSON（body、user，加上 GraphQL 的 editor）。
                           作者不是 bot、最後編輯者不是 bot 自己，或只有純文字內容時，不採用保存的狀態，
                           改從確認留言重播
  --comments <file>        PR 的 issue comments（GitHub REST 的 JSON 陣列）
  --permissions <file>     留言者的權限（JSON：{ "login": "write" | "maintain" | "admin" | ... }）
  --history <path>         之前 head 的報表（檔案或目錄）；狀態遺失時用來驗證確認指令的 @head。可重複
  --ack-permission <level> 確認所需的最低權限：write（預設）| maintain | admin
  --out <file>             寫出完整結果（JSON）
  --json                   stdout 輸出完整結果（取代儀表板 Markdown）
  --fail-on-pending        有待確認的項目時 exit code 1
  --unsigned               沒有 REVIEWER_STATE_KEY 時仍輸出（狀態不簽章，只供本機預覽）

環境變數：
  REVIEWER_STATE_KEY             狀態的 HMAC key（必填，除非 --unsigned）
  REVIEWER_STATE_PREVIOUS_KEYS   換 key 後仍可驗證的舊 key（以換行或逗號分隔）

exit code：0 完成；1 有待確認的項目（--fail-on-pending）；2 錯誤。`;

/**
 * 讀取 JSON 檔。
 *
 * @param {string} path - 路徑。
 * @param {string} code - 解析失敗時的錯誤代碼。
 * @returns {Promise<unknown>} 內容。
 */
async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${code}:${path}`);
  }
}

/**
 * 讀取儀表板留言：含 `body` 的 JSON（GitHub comment）原樣傳回，其他當成純文字。
 *
 * @param {string|undefined} path - 路徑。
 * @returns {Promise<object|string|null>} 留言或內容。
 */
async function readDashboard(path) {
  if (path === undefined) return null;
  const text = await readFile(path, 'utf8');
  if (text.trimStart().startsWith('{')) {
    try {
      const value = JSON.parse(text);
      // GitHub 留言的 JSON：保留作者與編輯者，用來判斷保存的狀態能不能採用。
      if (typeof value?.body === 'string') return value;
    } catch {
      // 不是 JSON：當成純文字。
    }
  }
  return text;
}

/**
 * 執行 `reviewer state`。
 *
 * @param {string[]} args - 參數（不含指令名稱）。
 * @returns {Promise<void>} 完成；結果以 stdout、stderr 與 `process.exitCode` 表示。
 */
export async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const { values } = parseArgs({
      args,
      options: {
        report: { type: 'string' },
        pr: { type: 'string' },
        dashboard: { type: 'string' },
        comments: { type: 'string' },
        permissions: { type: 'string' },
        history: { type: 'string', multiple: true },
        'ack-permission': { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        'fail-on-pending': { type: 'boolean' },
        unsigned: { type: 'boolean' },
      },
    });
    if (values.report === undefined) throw new Error('OPTION_MISSING:--report');
    if (values.pr === undefined) throw new Error('OPTION_MISSING:--pr');
    const minPermission = values['ack-permission'] ?? 'write';
    if (!ACK_PERMISSIONS.includes(minPermission)) throw new Error(`OPTION_INVALID:--ack-permission=${minPermission}`);
    const keys = stateKeys(process.env.REVIEWER_STATE_KEY, process.env.REVIEWER_STATE_PREVIOUS_KEYS);
    if (keys.current === null && !values.unsigned) throw new Error('REVIEW_STATE_KEY_MISSING:請設定 REVIEWER_STATE_KEY（本機預覽可加 --unsigned）');

    const [report, pr, dashboard, comments, permissions] = await Promise.all([
      readJson(values.report, 'REVIEW_STATE_REPORT_NOT_JSON'),
      readJson(values.pr, 'REVIEW_STATE_PR_NOT_JSON'),
      readDashboard(values.dashboard),
      values.comments === undefined ? [] : readJson(values.comments, 'REVIEW_STATE_COMMENTS_NOT_JSON'),
      values.permissions === undefined ? {} : readJson(values.permissions, 'REVIEW_STATE_PERMISSIONS_NOT_JSON'),
    ]);
    let history = [];
    if (values.history?.length) {
      const loaded = await loadReports(values.history);
      for (const error of loaded.errors) process.stderr.write(`warning: ${error}\n`);
      history = loaded.reports;
    }

    const result = updateReviewState({ report, pr, dashboard, comments, permissions, history, keys, minPermission });
    if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.dashboard.body}\n`);
    if (!result.dashboard.signed) process.stderr.write('warning: 狀態沒有簽章（--unsigned），下次執行時不會被採用\n');
    if (values['fail-on-pending'] && result.check.conclusion === 'failure') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isEntry(import.meta.url)) await run(process.argv.slice(2));
