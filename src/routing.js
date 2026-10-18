import { DECISION } from './contracts.js';

/**
 * 三層審查的路由：把第 1 層（機械）的 file-level 決策分成三條路。
 *
 * - `AUTO_PASS`：第 1 層判為不需要人工（`NOT_SELECTED_FOR_HUMAN_REVIEW`），不送 AI、不需人工。
 * - `AI_TRACK`：需要 review，但每個變更都已被 fact 解釋（`TARGETED`）且沒有單向門；交給 AI 審查。
 * - `ESCALATED`：有單向門、或有無法解釋 / 沒有分析的變更（`FULL`）；必須人工確認。
 *
 * 路由只會讓結果維持或變嚴格：它不改變 `decision`，也不會把 `HUMAN_REVIEW_REQUIRED` 變成 `AUTO_PASS`。
 */
export const TRACK = Object.freeze({
  AUTO_PASS: 'AUTO_PASS',
  AI_TRACK: 'AI_TRACK',
  ESCALATED: 'ESCALATED',
});

const SEVERITY = Object.freeze({ AUTO_PASS: 0, AI_TRACK: 1, ESCALATED: 2 });

/**
 * 預設的單向門（做了就難以回頭的變更）。專案設定只能加入，不能移除。
 */
export const DEFAULT_ONE_WAY_DOORS = Object.freeze([
  // 移除防護
  'TRANSACTION_BOUNDARY_REMOVED',
  'TRANSACTION_ROLLBACK_REMOVED',
  'ROW_LOCK_REMOVED',
  'AUTHORIZATION_GUARD_REMOVED',
  'AUTHORIZATION_ABILITY_CHANGED',
  'MIDDLEWARE_GUARD_REMOVED',
  'SIGNATURE_VERIFICATION_REMOVED',
  'GUARD_CLAUSE_REMOVED',
  'PROTECTED_CALL_REMOVED',
  // 改變關鍵值
  'PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED',
  'PROTECTED_ARGUMENT_CHANGED',
  'SENSITIVE_OPERAND_CHANGED',
  'MASS_ASSIGNMENT_CHANGED',
  'SERIALIZED_ATTRIBUTES_CHANGED',
  // 新增不可逆的外部副作用
  'SIDE_EFFECT_CALL_ADDED',
  'DATA_DELETION_ADDED',
  // 受保護的路徑與審查規則本身
  'PROTECTED_PATH',
  'POLICY_FILE_CHANGED',
]);

/**
 * 只有「沒有分析」的原因時，`routing.aiTrackPaths` 才能把 `FULL` 檔案交給 AI。
 * 分析失敗或看不懂（`COV-*`、`ANALYZER_*` 等）、binary、symlink、submodule 一律需要人工。
 */
const UNANALYZED_REASONS = new Set(['FILE_ADDED', 'FILE_DELETED', 'UNSUPPORTED_FILE_TYPE']);

/**
 * 原因代碼的基本代碼（`FACT_UNHANDLED:php-1` → `FACT_UNHANDLED`）。
 *
 * @param {string} reason - 原因代碼。
 * @returns {string} 基本代碼。
 */
function baseCode(reason) {
  return String(reason).split(':')[0];
}

/**
 * 決定單一檔案的路由。
 *
 * @param {object} file - review file result（`decision`、`fallback`、`reasons`、`path`）。
 * @param {object} [options={}] - 路由設定。
 * @param {Iterable<string>} [options.oneWayDoors=DEFAULT_ONE_WAY_DOORS] - 單向門代碼。
 * @param {function(string): boolean} [options.aiTrackPath] - 路徑是否可交給 AI（只用於沒有分析的 `FULL` 檔案）。
 * @returns {{track: string, oneWayDoors: string[]}} 路由與命中的單向門原因。
 */
export function routeFile(file, { oneWayDoors = DEFAULT_ONE_WAY_DOORS, aiTrackPath = () => false } = {}) {
  if (file?.decision === DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW) {
    return { track: TRACK.AUTO_PASS, oneWayDoors: [] };
  }

  const reasons = Array.isArray(file?.reasons) ? file.reasons : [];
  const doors = new Set(oneWayDoors);
  const matched = reasons.filter((reason) => doors.has(baseCode(reason)));
  if (matched.length > 0 || file?.decision !== DECISION.HUMAN_REVIEW_REQUIRED) {
    return { track: TRACK.ESCALATED, oneWayDoors: matched };
  }

  if (file.fallback === 'TARGETED') return { track: TRACK.AI_TRACK, oneWayDoors: [] };

  const unanalyzedOnly = reasons.length > 0 && reasons.every((reason) => UNANALYZED_REASONS.has(reason));
  return {
    track: unanalyzedOnly && aiTrackPath(file.path) ? TRACK.AI_TRACK : TRACK.ESCALATED,
    oneWayDoors: [],
  };
}

/**
 * 彙整 PR 層級路由：取最嚴格的檔案路由；沒有檔案時為 `AUTO_PASS`。
 *
 * @param {object[]} files - 已帶 `track` 的 file results。
 * @returns {{track: string, autoPass: number, aiTrack: number, escalated: number}} PR 路由。
 */
export function summarizeTracks(files) {
  const count = (track) => files.filter((file) => file.track === track).length;
  // 不認得的 track 視為 ESCALATED（fail-closed）。
  const worst = files.reduce((max, file) => Math.max(max, SEVERITY[file.track] ?? SEVERITY.ESCALATED), SEVERITY.AUTO_PASS);
  return {
    track: Object.keys(SEVERITY).find((track) => SEVERITY[track] === worst),
    autoPass: count(TRACK.AUTO_PASS),
    aiTrack: count(TRACK.AI_TRACK),
    escalated: count(TRACK.ESCALATED),
  };
}
