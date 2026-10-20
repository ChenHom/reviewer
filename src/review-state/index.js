import { decodeState } from './codec.js';
import { isBotComment, parseCommands } from './commands.js';
import { DASHBOARD_MARKER, renderDashboard, threadTargets } from './dashboard.js';
import { checkResult, computeState, itemLabel } from './machine.js';

/**
 * 二次 review 狀態的更新（設計 §8 步驟 7 的 CLI 部分）：輸入目前 head 的報表、上一版儀表板留言、PR 的留言與
 * 留言者權限，輸出新的儀表板、Check、確認指令的回覆與行內 thread 的目標狀態。不呼叫任何 GitHub API；
 * 寫回 PR 由呼叫端（workflow）負責。
 */

export const ACK_PERMISSIONS = Object.freeze(['write', 'maintain', 'admin']);

/**
 * 報表中確認要綁定的欄位是否齊全：專案設定與 codingstandards.md 的 digest、每個檔案的 `contentHash`，
 * 以及單向門 finding 的 `policyDigest`。
 * 缺少時無法判斷程式碼或規則是否改變（例如所有缺欄位的 head 都會得到相同的 fingerprint），所以不接受。
 *
 * @param {object} report - 報表。
 * @returns {string|null} 第一個錯誤，沒有時為 null。
 */
export function reportError(report) {
  if (!Array.isArray(report?.files) || typeof report?.head?.sha !== 'string' || report.head.sha === '') return 'REPORT_SHAPE_INVALID';
  const filled = (value) => typeof value === 'string' && value !== '';
  // 檔案層級項目的 policy：專案設定與（有 AI 審查時）codingstandards.md 的 digest。沒有設定檔或規範檔時是明確的 null，
  // 欄位缺漏則不接受（否則缺欄位的報表都得到相同的 policy）。
  const digestField = (owner) => owner !== null && typeof owner === 'object' && Object.hasOwn(owner, 'digest') && (owner.digest === null || filled(owner.digest));
  if (!digestField(report.config)) return 'CONFIG_DIGEST_MISSING';
  const aiRan = report.ai !== null && report.ai !== undefined;
  if (aiRan && !digestField(report.ai.standards)) return 'AI_STANDARDS_DIGEST_MISSING';
  if (!aiRan && report.files.some((file) => file?.ai !== undefined && file?.ai !== null)) return 'AI_SUMMARY_MISSING';
  for (const file of report.files) {
    if (!filled(file?.path)) return 'FILE_PATH_MISSING';
    if (!filled(file.contentHash)) return `FILE_CONTENT_HASH_MISSING:${file.path}`;
    for (const finding of (file.findings ?? []).filter((item) => item?.kind !== 'AI')) {
      if (!filled(finding.id) || !filled(finding.blocker)) return `FINDING_INVALID:${file.path}`;
      if (!filled(finding.policyDigest)) return `FINDING_POLICY_DIGEST_MISSING:${file.path}`;
      if (finding.scopeHash !== undefined && finding.scopeHash !== null && !filled(finding.scopeHash)) return `FINDING_SCOPE_HASH_INVALID:${file.path}`;
    }
  }
  return null;
}

/**
 * 儀表板留言的內容，以及保存的狀態能不能採用。簽章只保證狀態是 reviewer 產生的，不保證是最新的：
 * 有寫入權限的人可以把留言改回之前合法簽章的狀態（例如項目修正前的確認）。所以只採用 bot 自己建立、
 * 而且最後一次編輯也是 bot 自己（GraphQL 的 `editor`，沒有編輯過為 `null`）的留言中的狀態；
 * 沒有這些資訊（例如只傳入內容）時也不採用。
 *
 * @param {object|string|null} dashboard - 儀表板留言（GitHub REST 的 issue comment 加上 GraphQL 的 `editor`）。
 * @returns {{body: string|null, problem: string|null}} 內容與不採用的原因。
 */
function dashboardSource(dashboard) {
  if (dashboard === null || dashboard === undefined) return { body: null, problem: null };
  if (typeof dashboard === 'string') return { body: dashboard, problem: 'STATE_EDITOR_UNKNOWN' };
  const body = typeof dashboard.body === 'string' ? dashboard.body : null;
  const author = dashboard.user?.login;
  if (typeof author !== 'string' || author === '' || !isBotComment(dashboard)) return { body, problem: 'STATE_NOT_FROM_BOT' };
  if (!Object.hasOwn(dashboard, 'editor') || dashboard.editor === undefined) return { body, problem: 'STATE_EDITOR_UNKNOWN' };
  // REST 的 bot login 帶 `[bot]`，GraphQL 的不帶。
  const bare = (login) => login.toLowerCase().replace(/\[bot\]$/, '');
  const editor = dashboard.editor?.login;
  if (dashboard.editor !== null && (typeof editor !== 'string' || bare(editor) !== bare(author))) return { body, problem: 'STATE_EDITED_BY_OTHER' };
  return { body, problem: null };
}

/**
 * 更新二次 review 狀態。
 *
 * @param {object} options - 輸入。
 * @param {object} options.report - 目前 head 的報表（`bin/review.js --out`）。
 * @param {{number: number, user: {login: string}, head?: {sha: string}}} options.pr - PR（GitHub REST 形狀）。
 * @param {object|string|null} [options.dashboard=null] - 上一版儀表板留言（GitHub REST 的 issue comment 加上
 *   GraphQL 的 `editor`）。只傳入內容（字串）時不採用保存的狀態，從確認留言重播。
 * @param {object[]} [options.comments=[]] - PR 的 issue comments。
 * @param {object} [options.permissions={}] - login → 權限。
 * @param {object[]} [options.history=[]] - 之前 head 的報表。
 * @param {{current: object|null, all: object[]}} options.keys - stateKeys() 的結果。
 * @param {string} [options.minPermission='write'] - 確認所需的最低權限（write / maintain / admin）。
 * @returns {object} 輸出：`dashboard`、`check`、`replies`、`threads`、`items`、`notes`、`previousState`。
 */
export function updateReviewState({ report, pr, dashboard = null, comments = [], permissions = {}, history = [], keys, minPermission = 'write' }) {
  const invalid = reportError(report);
  if (invalid) throw new Error(`REVIEW_STATE_REPORT_INVALID:${invalid}`);
  if (!Number.isInteger(pr?.number) || typeof pr?.user?.login !== 'string' || pr.user.login === '') throw new Error('REVIEW_STATE_PR_INVALID');
  if (!ACK_PERMISSIONS.includes(minPermission)) throw new Error(`REVIEW_STATE_ACK_PERMISSION_INVALID:${minPermission}`);
  // 報表必須是 PR 目前的 head：舊的報表晚到時不能拿來更新狀態或 Check。
  if (typeof pr.head?.sha === 'string' && pr.head.sha !== report.head.sha) {
    throw new Error(`REVIEW_STATE_STALE_REPORT:${report.head.sha.slice(0, 12)}≠${pr.head.sha.slice(0, 12)}`);
  }
  if (!Array.isArray(comments)) throw new Error('REVIEW_STATE_COMMENTS_INVALID');

  const source = dashboardSource(dashboard);
  let previous = decodeState(source.body, { keys: keys.all, pullRequest: pr.number });
  if (previous.status === 'valid' && source.problem) {
    // 狀態本身合法，但無法確認是最新的（可能被改回舊的狀態）：從確認留言重播。
    previous = { status: 'invalid', state: null, reason: source.problem };
  } else if (previous.status === 'absent' && source.body?.includes(DASHBOARD_MARKER)) {
    // 有儀表板但沒有狀態（上次超過長度上限，或區塊被刪掉）：當成無法驗證，重播時不逐則回覆。
    previous = { status: 'invalid', state: null, reason: 'STATE_MISSING' };
  } else if (previous.status === 'absent'
    && comments.some((comment) => !isBotComment(comment) && parseCommands(comment?.body).some((command) => command.kind === 'ack'))) {
    // 沒有儀表板卻已經有確認指令（儀表板留言可能被刪除）：之前的狀態不明，同樣重播。
    previous = { status: 'invalid', state: null, reason: 'DASHBOARD_MISSING' };
  }
  const result = computeState({
    report,
    previous,
    comments,
    pr: { number: pr.number, login: pr.user.login },
    permissions,
    minPermission,
    // 欄位不齊全的歷史報表不用來驗證確認。
    history: history.filter((old) => reportError(old) === null),
  });
  const rendered = renderDashboard({ report, result, key: keys.current, minPermission });
  return {
    pullRequest: pr.number,
    headSha: report.head.sha,
    previousState: { status: previous.status, reason: previous.reason },
    dashboard: { body: rendered.body, stateSaved: rendered.stateSaved, signed: keys.current !== null },
    check: checkResult(report, result.items),
    replies: result.replies,
    threads: threadTargets(report, result.items),
    items: result.items.map((item) => ({
      id: item.id,
      label: itemLabel(item),
      kind: item.kind,
      state: item.state,
      blocker: item.blocker,
      path: item.path,
      location: item.location,
      ...(item.reopenedBecause ? { reopenedBecause: item.reopenedBecause } : {}),
    })),
    notes: result.notes,
  };
}
