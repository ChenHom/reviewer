import { ACK_USAGE } from './commands.js';
import { encodeState } from './codec.js';
import { ITEM_STATE, itemLabel } from './machine.js';

/**
 * 置頂儀表板（一則留言，原地更新）與行內 thread 的內容。
 *
 * 說明文字來自被審查的程式碼與 AI 的輸出，放進表格前跳脫：`<` `>` `&`（不能插入 HTML 或偽造隱藏區塊）、
 * `|` 與換行（不破壞表格）、`@`（不 mention 任何人）。
 */

/** 用來找到同一則儀表板留言的標記。 */
export const DASHBOARD_MARKER = '<!-- reviewer:dashboard v1 -->';
/** 用來找到同一個 finding 的行內 thread 的標記前綴。 */
export const THREAD_MARKER = 'reviewer:finding';
/** GitHub 留言的長度上限（字元）。 */
export const MAX_COMMENT_CHARS = 65_536;

const BLOCKER_LABELS = Object.freeze({
  AI_CONCERN: '🤖 AI 提出疑慮',
  AI_NEEDS_HUMAN: '🤖 AI 判斷需要人工',
  AI_REVIEW_FAILED: '🤖 AI 審查失敗',
  AI_REVIEW_MISSING: '🤖 沒有 AI 審查',
  HUMAN_REVIEW_REQUIRED: '需要人工',
});

const REOPENED_LABELS = Object.freeze({
  CODE_CHANGED: '確認後程式碼又改了',
  POLICY_CHANGED: '確認後規則已更新',
  REAPPEARED: '修正後再次出現',
});

/**
 * 跳脫放進 Markdown 表格或段落的文字。
 *
 * @param {unknown} value - 文字。
 * @param {number} [limit=200] - 最大長度（字元）。
 * @returns {string} 跳脫後的文字。
 */
export function escapeText(value, limit = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/@/g, '&#64;')
    .replace(/`/g, '&#96;');
}

/**
 * 放進 code span 的文字（路徑）：code span 中不解讀 HTML 與 mention，只需要處理反引號、換行與表格的 `|`。
 *
 * @param {unknown} value - 文字。
 * @param {number} [limit=160] - 最大長度（字元）。
 * @returns {string} code span。
 */
function codeSpan(value, limit = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/`/g, "'");
  const clipped = text.length > limit ? `…${text.slice(text.length - limit + 1)}` : text;
  return `\`${clipped.replace(/\|/g, '\\|')}\``;
}

/**
 * 項目的風險欄位。
 *
 * @param {object} item - 項目。
 * @returns {string} 顯示文字。
 */
function riskLabel(item) {
  if (item.kind === 'FILE') {
    const label = BLOCKER_LABELS[item.blocker] ?? escapeText(item.blocker);
    return item.blocker === 'AI_CONCERN' && item.concerns > 1 ? `${label} ×${item.concerns}` : label;
  }
  return `🚪 ${escapeText(item.blocker)}`;
}

/**
 * 項目的位置欄位。
 *
 * @param {object} item - 項目。
 * @returns {string} 顯示文字。
 */
function locationLabel(item) {
  const location = item.location;
  if (!location?.startLine) return codeSpan(item.path);
  return `${codeSpan(`${item.path}:${location.startLine}`)}${location.side === 'base' ? '（已刪除的行）' : ''}`;
}

/**
 * 項目的說明欄位。
 *
 * @param {object} item - 項目。
 * @returns {string} 顯示文字。
 */
function descriptionLabel(item) {
  if (item.kind === 'FILE' && !item.description) {
    if (item.blocker === 'AI_REVIEW_MISSING') return '沒有執行 AI 審查，請人工看過整個檔案';
    return '請人工看過整個檔案';
  }
  return escapeText(item.description ?? (item.kind === 'FILE' ? '' : '檔案層級的單向門'));
}

/**
 * 項目的狀態欄位。
 *
 * @param {object} item - 項目。
 * @returns {string} 顯示文字。
 */
function stateLabel(item) {
  switch (item.state) {
    case ITEM_STATE.OPEN:
      return '🔴 待確認';
    case ITEM_STATE.REOPENED:
      return `🟠 重新開啟（${REOPENED_LABELS[item.reopenedBecause] ?? '需要重新確認'}）`;
    case ITEM_STATE.ACKNOWLEDGED: {
      const ack = item.acks.at(-1);
      return `✅ ${escapeText(ack?.login ?? '', 40)} 已確認（\`${String(ack?.sha ?? '').slice(0, 7)}\`）：${escapeText(ack?.reason ?? '', 120)}`;
    }
    default:
      return '🟢 已修正';
  }
}

/**
 * 儀表板的可見內容（不含隱藏狀態）。
 *
 * @param {object} options - 內容。
 * @param {object} options.report - 目前 head 的報表。
 * @param {object[]} options.items - computeState() 的 items。
 * @param {object[]} options.notes - computeState() 的 notes 與其他說明。
 * @param {string} options.minPermission - 確認所需的最低權限。
 * @param {boolean} [options.compact=false] - 省略檔案清單（留言太長時）。
 * @returns {string} Markdown。
 */
export function formatDashboard({ report, items, notes, minPermission, compact = false }) {
  const head = String(report.head.sha).slice(0, 7);
  const pending = items.filter((item) => [ITEM_STATE.OPEN, ITEM_STATE.REOPENED].includes(item.state));
  const done = items.filter((item) => [ITEM_STATE.ACKNOWLEDGED, ITEM_STATE.FIXED].includes(item.state));
  const acknowledged = items.filter((item) => item.state === ITEM_STATE.ACKNOWLEDGED);
  const fixed = items.filter((item) => item.state === ITEM_STATE.FIXED);
  const lines = [DASHBOARD_MARKER];

  if (pending.length > 0) lines.push(`## 🔴 需要人工確認 · ${pending.length} 項 · head \`${head}\``);
  else if (acknowledged.length > 0) lines.push(`## ✅ 人工確認完成 · head \`${head}\``);
  else lines.push(`## 🟢 不需要人工確認 · head \`${head}\``);

  const files = report.files ?? [];
  const count = (track) => files.filter((file) => file.track === track).length;
  const aiPassed = files.filter((file) => file.track === 'AI_TRACK' && file.needsHuman === false);
  const autoPass = files.filter((file) => file.track === 'AUTO_PASS');
  const summary = [`變更 ${files.length} 個檔案`, `機械審查略過 ${autoPass.length}`, `交給 AI ${count('AI_TRACK')}`, `單向門 ${count('ESCALATED')}`];
  if (report.ai) summary.push(`AI 審查通過 ${aiPassed.length}`);
  lines.push('', summary.join(' · '));

  for (const note of notes) {
    if (note.code === 'STATE_RESET') {
      lines.push('', `> ⚠️ 先前的狀態無法驗證（${escapeText(note.reason, 60)}），已從頭重算：重新驗證了 ${note.replayed} 個確認，其中 ${note.rejected} 個無法驗證，需要重新確認。`);
    } else if (note.code === 'STATE_OVERFLOW') {
      lines.push('', '> ⚠️ 狀態超過留言長度上限，這次沒有保存；下次會從確認留言重新計算。');
    }
  }

  if (pending.length > 0) {
    lines.push('', '| # | 風險 | 位置 | 說明 | 狀態 | 確認指令 |', '|---|---|---|---|---|---|');
    for (const item of pending) {
      const label = itemLabel(item);
      lines.push(`| ${label} | ${riskLabel(item)} | ${locationLabel(item)} | ${descriptionLabel(item)} | ${stateLabel(item)} | \`/reviewer ack ${label}@${head}\` |`);
    }
    lines.push('', `看過後留言確認：${ACK_USAGE}。需要 ${minPermission} 以上的權限，PR 作者不能確認自己的變更。`
      + '確認綁定目前的程式碼：🚪 單向門綁定所在的 method，🤖 檔案層級的項目綁定整個檔案的內容；之後再改動會重新開啟。');
  }

  if (done.length > 0) {
    lines.push('', `<details><summary>✅ 已確認 ${acknowledged.length} · 🟢 已修正 ${fixed.length}</summary>`, '',
      '| # | 風險 | 位置 | 狀態 |', '|---|---|---|---|');
    for (const item of done) lines.push(`| ${itemLabel(item)} | ${riskLabel(item)} | ${locationLabel(item)} | ${stateLabel(item)} |`);
    lines.push('', '</details>');
  }

  const fileList = (title, list) => {
    if (list.length === 0) return;
    lines.push('', `<details><summary>${title} ${list.length} 個檔案</summary>`, '');
    if (compact) lines.push('（留言長度上限，省略清單）');
    else for (const file of list) lines.push(`- ${codeSpan(file.path)}`);
    lines.push('', '</details>');
  };
  fileList('🤖 AI 審查通過', aiPassed);
  fileList('⚪ 機械審查判定可略過', autoPass);
  return lines.join('\n');
}

/**
 * 狀態縮小：先減少保存的 head，再移除已修正項目的確認。保留目前 head 與有效確認。
 *
 * @param {object} state - 狀態。
 * @returns {object[]} 由大到小的候選狀態。
 */
function shrinkCandidates(state) {
  const candidates = [state];
  for (let keep = state.heads.length - 1; keep >= 1; keep -= 1) candidates.push({ ...state, heads: state.heads.slice(-keep) });
  const fixedIds = new Set(Object.entries(state.items).filter(([, item]) => item.state === ITEM_STATE.FIXED).map(([id]) => id));
  candidates.push({ ...state, heads: state.heads.slice(-1), acks: state.acks.filter((ack) => !fixedIds.has(ack.itemId)) });
  return candidates;
}

/**
 * 完整的儀表板留言：可見內容加上隱藏狀態，不超過留言長度上限。太長時依序省略檔案清單、縮小狀態；
 * 仍然太長時不保存狀態（下次從確認留言重算，結果只會更嚴格）並在儀表板說明。
 *
 * @param {object} options - 內容。
 * @param {object} options.report - 目前 head 的報表。
 * @param {object} options.result - computeState() 的結果。
 * @param {{id: string, key: string}|null} options.key - 簽章用的 key（null 時不簽章）。
 * @param {string} options.minPermission - 確認所需的最低權限。
 * @param {number} [options.limit=MAX_COMMENT_CHARS] - 長度上限。
 * @returns {{body: string, stateSaved: boolean}} 留言內容。
 */
export function renderDashboard({ report, result, key, minPermission, limit = MAX_COMMENT_CHARS }) {
  const base = { report, items: result.items, notes: result.notes, minPermission };
  for (const compact of [false, true]) {
    const visible = formatDashboard({ ...base, compact });
    for (const state of shrinkCandidates(result.state)) {
      const body = `${visible}\n\n${encodeState(state, key)}`;
      if (body.length <= limit) return { body, stateSaved: true };
    }
  }
  const visible = formatDashboard({ ...base, notes: [...result.notes, { code: 'STATE_OVERFLOW' }], compact: true });
  return { body: visible.length <= limit ? visible : `${visible.slice(0, limit - 1)}…`, stateSaved: false };
}

/**
 * 行內 thread 的目標狀態（只為單向門開；`FIXED` / `ACKNOWLEDGED` 為 resolved）。呼叫端以 thread 內容中的
 * `<!-- reviewer:finding <id> -->` 找到既有的 thread：沒有就建立（只建立 open 的），有就 resolve / unresolve。
 *
 * @param {object} report - 目前 head 的報表。
 * @param {object[]} items - computeState() 的 items。
 * @returns {object[]} thread 的目標狀態。
 */
export function threadTargets(report, items) {
  const head = String(report.head.sha).slice(0, 7);
  return items.filter((item) => item.kind === 'DOOR').map((item) => {
    const open = [ITEM_STATE.OPEN, ITEM_STATE.REOPENED].includes(item.state);
    const label = itemLabel(item);
    const location = item.location?.startLine ? {
      path: item.path,
      side: item.location.side === 'base' ? 'LEFT' : 'RIGHT',
      startLine: item.location.startLine,
      line: item.location.endLine ?? item.location.startLine,
    } : null;
    return {
      findingId: item.id,
      label,
      state: open ? 'open' : 'resolved',
      location,
      body: [
        `**${label} · ${escapeText(item.blocker)}**（單向門，需要人工確認）`,
        '',
        descriptionLabel(item),
        '',
        `看過後留言 \`/reviewer ack ${label}@${head} <理由>\`。`,
        `<!-- ${THREAD_MARKER} ${item.id} -->`,
      ].join('\n'),
    };
  });
}
