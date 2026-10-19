import { DECISION } from './contracts.js';

/**
 * 三層審查的路由。核心流程是串接的：機械審查 → AI 審查剩下的 → AI 審查後需要人工的才交給人工。
 *
 * - `AUTO_PASS`：機械審查判為不需要 review（`NOT_SELECTED_FOR_HUMAN_REVIEW`），不送 AI、不需人工。
 * - `AI_TRACK`：交給 AI 審查，由 AI 判斷是否需要人工。包括每個變更都已被 fact 解釋的檔案，
 *   以及機械審查無法解釋或沒有分析的檔案（`FULL`）。
 * - `ESCALATED`：命中單向門。同樣先交給 AI 審查（AI 可以補充說明與流程圖），但 **AI 不能放行**，
 *   之後一律交給人工確認。
 *
 * 路由不改變 `decision`：`HUMAN_REVIEW_REQUIRED` 表示機械審查之後還需要 review（AI，必要時人工）。
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
  // 受保護的路徑與審查規則本身；設定無效時專案的單向門規則沒有套用，必須人工確認
  'PROTECTED_PATH',
  'POLICY_FILE_CHANGED',
  'POLICY_CONFIG_INVALID',
]);

/**
 * 原因代碼的基本代碼（`FACT_UNHANDLED:php-1` → `FACT_UNHANDLED`）。
 *
 * @param {string} reason - 原因代碼。
 * @returns {string} 基本代碼。
 */
export function baseCode(reason) {
  return String(reason).split(':')[0];
}

/**
 * 決定單一檔案的路由。
 *
 * @param {object} file - review file result（`decision`、`reasons`）。
 * @param {object} [options={}] - 路由設定。
 * @param {Iterable<string>} [options.oneWayDoors=DEFAULT_ONE_WAY_DOORS] - 單向門代碼。
 * @returns {{track: string, oneWayDoors: string[]}} 路由與命中的單向門原因。
 */
export function routeFile(file, { oneWayDoors = DEFAULT_ONE_WAY_DOORS } = {}) {
  if (file?.decision === DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW) {
    return { track: TRACK.AUTO_PASS, oneWayDoors: [] };
  }

  const reasons = Array.isArray(file?.reasons) ? file.reasons : [];
  const doors = new Set(oneWayDoors);
  const matched = reasons.filter((reason) => doors.has(baseCode(reason)));
  // 不認得的 decision 視為需要人工（fail-closed）。
  if (matched.length > 0 || file?.decision !== DECISION.HUMAN_REVIEW_REQUIRED) {
    return { track: TRACK.ESCALATED, oneWayDoors: matched };
  }
  return { track: TRACK.AI_TRACK, oneWayDoors: [] };
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
