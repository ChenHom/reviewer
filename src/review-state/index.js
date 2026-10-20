import { decodeState } from './codec.js';
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
 * 更新二次 review 狀態。
 *
 * @param {object} options - 輸入。
 * @param {object} options.report - 目前 head 的報表（`bin/review.js --out`）。
 * @param {{number: number, user: {login: string}, head?: {sha: string}}} options.pr - PR（GitHub REST 形狀）。
 * @param {string|null} [options.dashboard=null] - 上一版儀表板留言內容。
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

  let previous = decodeState(dashboard, { keys: keys.all, pullRequest: pr.number });
  // 有儀表板但沒有狀態（上次超過長度上限，或區塊被刪掉）：當成無法驗證，重播時不逐則回覆。
  if (previous.status === 'absent' && typeof dashboard === 'string' && dashboard.includes(DASHBOARD_MARKER)) {
    previous = { status: 'invalid', state: null, reason: 'STATE_MISSING' };
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
