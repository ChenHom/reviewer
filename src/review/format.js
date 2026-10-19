import { TRACK } from '../routing.js';
import { REASON_HINTS } from './reasons.js';
import { NOT_SELECTED } from './review.js';

const MAX_LISTED = 8;

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
    const aiReview = routing.aiTrack + routing.escalated;
    lines.push(`路由：${routing.track}（交給 AI 審查 ${aiReview}，其中 ${routing.escalated} 個 AI 審查後必須人工確認；不需要 review ${routing.autoPass}）`);
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

  if (report.ai) {
    lines.push(...aiLines(report, needsReview));
  } else {
    lines.push(...trackLines(report, needsReview));
  }

  if (reduced.length > 0) {
    lines.push('', `不需要 review（${reduced.length}）：`);
    lines.push(...reduced.map((file) => `  ${file.path}`));
  }

  return lines.join('\n');
}

/**
 * 沒有 AI 審查時依路由分組的段落。
 *
 * @param {object} report - review report。
 * @param {object[]} needsReview - 需要 review 的檔案。
 * @returns {string[]} 文字行。
 */
function trackLines(report, needsReview) {
  const lines = [];
  // 有路由時依路由分組；沒有路由資訊（或不認得的 track）的檔案歸入必須人工確認。
  const sections = report.routing
    ? [
      ['AI 審查後必須人工確認（ESCALATED，單向門）：', needsReview.filter((file) => file.track !== TRACK.AI_TRACK)],
      ['交給 AI 審查，由 AI 判斷是否需要人工（AI_TRACK）：', needsReview.filter((file) => file.track === TRACK.AI_TRACK)],
    ]
    : [['需要 review：', needsReview]];
  for (const [heading, files] of sections) {
    if (files.length === 0) continue;
    lines.push('', heading);
    for (const file of ordered(files)) lines.push(...fileLines(file));
  }
  return lines;
}

const AI_STATUS_TEXT = Object.freeze({
  PASS: '未發現問題',
  NEEDS_HUMAN: '需要人工',
  FIXED: '已修正（尚未 commit）',
  FAILED: '審查失敗',
});

/**
 * 單一檔案的 AI 審查結果。
 *
 * @param {object} file - 帶 `ai` 的 file result。
 * @returns {string[]} 文字行。
 */
function aiFileLines(file) {
  const { ai } = file;
  if (!ai) return [];
  const status = AI_STATUS_TEXT[ai.status] ?? ai.status;
  const detail = ai.status === 'FAILED' ? ai.error : snippetLine(ai.summary);
  const lines = [`           AI：${status}${detail ? ` — ${detail}` : ''}${ai.fallback ? `（由備援模型 ${ai.model} 回答）` : ''}`];
  for (const concern of (ai.concerns ?? []).slice(0, MAX_LISTED)) {
    const where = concern.startLine > 0 ? `（${concern.side}:L${concern.startLine}${concern.endLine === concern.startLine ? '' : `-${concern.endLine}`}）` : '';
    lines.push(`           ! [${concern.severity}] ${snippetLine(concern.title)}${where}`);
  }
  if ((ai.concerns ?? []).length > MAX_LISTED) lines.push(`           ! …另有 ${ai.concerns.length - MAX_LISTED} 項（見 --json）`);
  if (ai.fix && !ai.fix.applied) {
    lines.push(`           修正建議：${snippetLine(ai.fix.description)}${ai.fix.error ? `（未套用：${ai.fix.error}）` : '（未套用）'}`);
  }
  return lines;
}

/**
 * 壓成一行並截斷。
 *
 * @param {unknown} value - 文字。
 * @returns {string} 單行文字。
 */
function snippetLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * AI 審查後的段落：需要人工確認、AI 已修正、AI 審查通過。
 *
 * @param {object} report - review report。
 * @param {object[]} needsReview - 需要 review 的檔案。
 * @returns {string[]} 文字行。
 */
function aiLines(report, needsReview) {
  const { ai, human } = report;
  const lines = [
    `AI 審查：${ai.model}（effort ${ai.effort}）${ai.reviewed} 個檔案：未發現問題 ${ai.pass}、需要人工 ${ai.needsHuman}、已修正 ${ai.fixed}、失敗 ${ai.failed}；${ai.standards.present ? `依 ${ai.standards.path}` : `沒有 ${ai.standards.path}`}`,
    `人工：${human.required ? `需要確認 ${human.files} 個檔案（${human.findings} 項）` : '不需要'}`,
  ];
  const groups = [
    ['需要人工確認：', needsReview.filter((file) => file.needsHuman)],
    ['AI 已修正（尚未 commit；commit 後會重新 review）：', needsReview.filter((file) => !file.needsHuman && file.ai?.status === 'FIXED')],
  ];
  for (const [heading, files] of groups) {
    if (files.length === 0) continue;
    lines.push('', `${heading.slice(0, -1)}（${files.length}）：`);
    for (const file of ordered(files)) {
      const marker = file.track === TRACK.AI_TRACK ? '' : '（單向門）';
      const [first, ...rest] = fileLines(file);
      lines.push(`${first}${marker}`, ...rest, ...aiFileLines(file));
    }
  }
  const passed = needsReview.filter((file) => !file.needsHuman && file.ai?.status === 'PASS');
  if (passed.length > 0) {
    lines.push('', `AI 審查通過（${passed.length}）：`);
    lines.push(...passed.map((file) => `  ${file.path}${file.ai.summary ? ` — ${snippetLine(file.ai.summary)}` : ''}`));
  }
  return lines;
}
