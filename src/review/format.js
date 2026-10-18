import { TRACK } from '../routing.js';
import { NOT_SELECTED } from './review.js';

const MAX_LISTED = 8;

const REASON_HINTS = Object.freeze({
  FILE_ADDED: '新增的檔案',
  FILE_DELETED: '刪除的檔案',
  FILE_RENAMED: '檔案改名或搬移（autoload 路徑可能改變）',
  FILE_MODE_CHANGED: '檔案權限改變',
  UNSUPPORTED_FILE_TYPE: '不支援的檔案類型，未分析',
  BINARY_FILE: 'binary 檔案，未分析',
  SYMLINK_CHANGED: 'symlink 變更',
  SUBMODULE_CHANGED: 'submodule 變更',
  'COV-PHP-001:UNRECOGNIZED_PHP_CHANGE': '有無法自動解釋的變更，請看整個檔案',
  'COV-PHP-001:PHP_GRAMMAR_DIVERGENCE': 'PHP 7 與 PHP 8 的解讀不同，請看整個檔案',
  'COV-PHP-001:PHP_PARSE_ERROR': '無法解析，請看整個檔案',
  'COV-PHP-001:PHP_FILE_DELETION_UNSUPPORTED': '檔案被清空',
  'COV-TS-001:UNRECOGNIZED_TS_CHANGE': '有排版、註解、區域變數改名以外的變更，請看整個檔案',
  'COV-TS-001:DIRECTIVE_COMMENT_CHANGED': '有語意的註解（@ts-ignore、eslint-disable 等）改變，請看整個檔案',
  'COV-TS-001:TS_PARSE_ERROR': '無法解析，請看整個檔案',
  'COV-TS-001:TS_FILE_DELETION_UNSUPPORTED': '檔案被清空',
});

/**
 * 原因代碼加上中文提示（若有）；單向門標示「單向門」。
 *
 * @param {string} reason - 原因代碼。
 * @param {Set<string>} oneWayDoors - 這個檔案命中的單向門原因。
 * @returns {string|null} 顯示文字；`FACT_UNHANDLED` 另外彙總，回傳 null。
 */
function describeReason(reason, oneWayDoors) {
  if (reason.startsWith('FACT_UNHANDLED:')) return null;
  const hint = oneWayDoors.has(reason) ? '單向門' : REASON_HINTS[reason];
  return hint ? `${reason}（${hint}）` : reason;
}

/**
 * 一個需要 review 的檔案的文字區塊。
 *
 * @param {object} file - file result。
 * @returns {string[]} 文字行。
 */
function fileLines(file) {
  const lines = [];
  const rename = file.oldPath ? `（原 ${file.oldPath}）` : '';
  const oneWayDoors = new Set(file.oneWayDoors ?? []);
  lines.push(`  ${(file.fallback ?? 'FULL').padEnd(8)} ${file.path}${rename}`);
  for (const reason of file.reasons.map((item) => describeReason(item, oneWayDoors)).filter(Boolean)) {
    lines.push(`           - ${reason}`);
  }
  const unhandled = file.reasons.filter((reason) => reason.startsWith('FACT_UNHANDLED:')).length;
  if (unhandled > 0) {
    lines.push(`           - FACT_UNHANDLED ×${unhandled}（有變更但沒有對應的 domain 規則，請看標示位置）`);
  }
  if (file.changedLines?.length > 0) {
    const ranges = file.changedLines.slice(0, MAX_LISTED).map(location).join('、');
    const more = file.changedLines.length > MAX_LISTED ? ` 等 ${file.changedLines.length} 處` : '';
    lines.push(`           變更位置：${ranges}${more}`);
  }
  for (const fact of file.facts.slice(0, MAX_LISTED)) {
    lines.push(`           · ${location(fact)} ${fact.description}`);
  }
  if (file.facts.length > MAX_LISTED) {
    lines.push(`           · …另有 ${file.facts.length - MAX_LISTED} 項（見 --json）`);
  }
  return lines;
}

/**
 * FULL 在前、再依路徑排序。
 *
 * @param {object[]} files - file results。
 * @returns {object[]} 排序後的 files。
 */
function ordered(files) {
  return [...files].sort((left, right) => (
    (left.fallback === 'FULL' ? 0 : 1) - (right.fallback === 'FULL' ? 0 : 1) || left.path.localeCompare(right.path)
  ));
}

/**
 * 行號範圍文字，例如 `head:L12` 或 `base:L30-34`。
 *
 * @param {object} fact - file result 中的 fact。
 * @returns {string} 位置。
 */
function location(fact) {
  const lines = fact.startLine === fact.endLine ? `L${fact.startLine}` : `L${fact.startLine}-${fact.endLine}`;
  return `${fact.side}:${lines}`;
}

/**
 * 把 review report 轉成人類可讀的文字。
 *
 * @param {object} report - reviewRange() 結果。
 * @returns {string} multi-line report。
 */
export function formatReview(report) {
  const { decision } = report;
  const needsReview = report.files.filter((file) => file.decision !== NOT_SELECTED);
  const reduced = report.files.filter((file) => file.decision === NOT_SELECTED);
  const lines = [
    `Review：${decision.status}（${needsReview.length}/${decision.files} 個檔案需要 review；TARGETED ${decision.targeted}、FULL ${decision.full}）`,
  ];
  if (report.routing) {
    const { routing } = report;
    lines.push(`路由：${routing.track}（需要人工確認 ${routing.escalated}、交給 AI 審查 ${routing.aiTrack}、不需要 review ${routing.autoPass}）`);
  }
  lines.push(
    `${report.repository}  ${report.base.ref} (${report.base.sha.slice(0, 12)}) → ${report.head.ref} (${report.head.sha.slice(0, 12)})${
      report.mergeBase && report.mergeBase !== report.base.sha ? `，比較起點為 merge base ${report.mergeBase.slice(0, 12)}` : ''
    }`,
  );

  if (decision.files === 0) {
    lines.push('', '沒有任何檔案變更。');
    return lines.join('\n');
  }

  // 有路由時依路由分組；沒有路由資訊（或不認得的 track）的檔案歸入需要人工確認。
  const sections = report.routing
    ? [
      ['需要人工確認（ESCALATED）：', needsReview.filter((file) => file.track !== TRACK.AI_TRACK)],
      ['交給 AI 審查（AI_TRACK）：', needsReview.filter((file) => file.track === TRACK.AI_TRACK)],
    ]
    : [['需要 review：', needsReview]];
  for (const [heading, files] of sections) {
    if (files.length === 0) continue;
    lines.push('', heading);
    for (const file of ordered(files)) lines.push(...fileLines(file));
  }

  if (reduced.length > 0) {
    lines.push('', `不需要 review（${reduced.length}）：`);
    lines.push(...reduced.map((file) => `  ${file.path}`));
  }

  return lines.join('\n');
}
