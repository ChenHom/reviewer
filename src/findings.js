import { createHash } from 'node:crypto';

import { canonicalizeJsonValue } from './facts/contracts.js';
import { structuredCallee, structuredContainer } from './facts/structured.js';
import { TRACK, baseCode } from './routing.js';

/**
 * 二次 review 的追蹤單位：必須人工確認的項目（finding）。
 *
 * - 每個帶單向門 blocker 的 fact，每個 blocker 一個 finding；
 * - 檔案層級的單向門原因（`PROTECTED_PATH`、`POLICY_FILE_CHANGED`、`POLICY_CONFIG_INVALID`）各一個 finding。
 *
 * 只有路由為 `ESCALATED` 的檔案有機械審查的 finding。其他需要 review 的變更（含機械審查無法解釋的部分）
 * 由 AI 審查；AI 判斷需要人工的項目由 `aiFindingsFor()` 加入。
 *
 * finding id = sha256(path, subject, kind, blocker, anchor, ordinal)，不含行號與 byte offset，
 * 所以在上方插入程式碼不會讓 finding 變成新的。`anchor` 是 fact 中不隨位置改變的內容；
 * 同一個 subject 內 anchor 相同的 finding 依出現順序編 `ordinal`，避免兩件事被合併成一件。
 *
 * `scopeHash` 是人工豁免要綁定的內容：fact 所屬 method / function 的 canonical AST hash
 * （analyzer 輸出的 `properties.scope`），沒有時（檔案層級的 finding、沒有 scope 的 analyzer）
 * 為整個檔案的 git blob id。
 */

/**
 * 運算式文字壓成單一空白，避免排版影響 anchor。
 *
 * @param {unknown} value - 原始碼片段。
 * @returns {string} 正規化後的文字。
 */
function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * callee 的 anchor（名稱、receiver 與呼叫種類）。
 *
 * @param {unknown} value - structured callee。
 * @returns {object|null} anchor。
 */
function calleeAnchor(value) {
  const callee = structuredCallee(value);
  return callee ? { name: callee.name, receiver: callee.receiver, kind: callee.kind } : null;
}

/**
 * container 的 anchor（不含顯示文字）。
 *
 * @param {unknown} value - structured container。
 * @returns {object|null} anchor。
 */
function containerAnchor(value) {
  const container = structuredContainer(value);
  if (!container) return null;
  return {
    type: container.type,
    keys: container.keys,
    name: container.name ?? null,
    callee: calleeAnchor(container.callee),
    argument: container.argument ?? null,
  };
}

/**
 * fact 中不隨位置改變的內容。
 *
 * @param {object} fact - semantic fact。
 * @returns {object} anchor。
 */
export function factAnchor(fact) {
  const p = fact.properties ?? {};
  switch (fact.kind) {
    case 'CALL_REMOVED':
    case 'CALL_ADDED':
      return { callee: calleeAnchor(p.callee) };
    case 'CALL_ARGUMENT_CHANGED':
    case 'CALL_ARGUMENT_REMOVED':
    case 'CALL_ARGUMENT_ADDED':
      return { callee: calleeAnchor(p.callee), argument: p.argument ?? null };
    case 'BINARY_OPERATOR_CHANGED':
      return { operator: `${p.operatorBefore}→${p.operatorAfter}`, before: compact(p.before) };
    case 'ARRAY_ITEM_REMOVED':
    case 'ARRAY_ITEM_ADDED':
      return { container: containerAnchor(p.container), key: compact(p.key), value: compact(p.value) };
    case 'LITERAL_CHANGED':
      return { container: containerAnchor(p.container), before: compact(p.before), after: compact(p.after) };
    case 'GUARD_REMOVED':
    case 'GUARD_ADDED':
      return { condition: compact(p.condition), exit: p.exit ?? null };
    default: {
      // 其他 fact：去掉位置相關與 scope 資訊後的 properties。
      const { scope, changeSide, ...rest } = p;
      return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, typeof value === 'string' ? compact(value) : value]));
    }
  }
}

/**
 * 穩定的 sha256。
 *
 * @param {unknown} value - JSON value。
 * @returns {string} hex digest。
 */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalizeJsonValue(value))).digest('hex');
}

/**
 * 計算單一檔案的 findings。
 *
 * @param {object} file - review file result（含 `track`、`reasons`、`facts[].blockers`）。
 * @param {object} options - 選項。
 * @param {Iterable<string>} options.oneWayDoors - 單向門代碼。
 * @returns {object[]} findings（依出現順序；檔案層級的在最後）。
 */
export function findingsFor(file, { oneWayDoors }) {
  if (file.track !== TRACK.ESCALATED) return [];

  const doors = new Set(oneWayDoors);
  const fileHash = file.contentHash;
  const drafts = [];

  for (const fact of file.facts ?? []) {
    for (const blocker of fact.blockers ?? []) {
      // 與路由相同，以基本代碼比對（設定可以把 `FACT_UNHANDLED` 等帶參數的代碼列為單向門）。
      if (!doors.has(baseCode(blocker))) continue;
      drafts.push({
        subject: fact.subject ?? file.path,
        kind: fact.kind,
        blocker,
        anchor: fact.anchor ?? null,
        scopeHash: fact.scopeHash ?? fileHash,
        location: { side: fact.side, startLine: fact.startLine, endLine: fact.endLine },
        description: fact.description,
      });
    }
  }

  const factBlockers = new Set((file.facts ?? []).flatMap((fact) => fact.blockers ?? []));
  const fileReasons = (file.reasons ?? []).filter((reason) => doors.has(baseCode(reason)) && !factBlockers.has(reason));
  for (const reason of fileReasons) {
    drafts.push({
      subject: file.path,
      kind: 'FILE',
      blocker: reason,
      anchor: reason,
      scopeHash: fileHash,
      location: null,
      description: null,
    });
  }

  return numbered(file.path, drafts);
}

/**
 * finding drafts 加上 `ordinal` 與 id。
 *
 * @param {string} path - 檔案路徑。
 * @param {object[]} drafts - drafts。
 * @returns {object[]} findings。
 */
function numbered(path, drafts) {
  const seen = new Map();
  return drafts.map((draft) => {
    const group = digest([path, draft.subject, draft.kind, draft.blocker, draft.anchor]);
    const ordinal = seen.get(group) ?? 0;
    seen.set(group, ordinal + 1);
    return {
      id: digest([path, draft.subject, draft.kind, draft.blocker, draft.anchor, ordinal]),
      path,
      ...draft,
      ordinal,
    };
  });
}

/**
 * AI 審查後必須人工確認的項目（`kind: AI`）：
 *
 * - AI 判斷需要人工（含單向門檔案上 AI 提出的疑慮）：每個 high / medium 的 concern 一個 finding
 *   （`AI_CONCERN`）；沒有這類 concern 時一個 `AI_NEEDS_HUMAN`。
 * - AI 審查失敗的 `AI_TRACK` 檔案：一個 `AI_REVIEW_FAILED`（單向門檔案本來就要人工確認）。
 * - AI 的修正沒有套用（未啟用 `--ai-apply`、或套用失敗）時同 AI 判斷需要人工。
 *
 * AI 的輸出不是 deterministic 的，同一個問題在兩次審查中的標題可能不同，所以 AI finding 的 id 不保證穩定；
 * `scopeHash` 一律綁定整個檔案的內容（`contentHash`）。
 *
 * @param {object} file - 已帶 `ai` 的 file result。
 * @returns {object[]} AI findings。
 */
export function aiFindingsFor(file) {
  const { ai } = file;
  if (!ai || file.track === TRACK.AUTO_PASS) return [];
  const base = { subject: file.path, kind: 'AI', scopeHash: file.contentHash };
  if (ai.status === 'FAILED') {
    return file.track === TRACK.AI_TRACK
      ? numbered(file.path, [{ ...base, blocker: 'AI_REVIEW_FAILED', anchor: ai.error, location: null, description: ai.error }])
      : [];
  }
  const concerns = (ai.concerns ?? []).filter((concern) => concern.severity !== 'low');
  // AI_TRACK：只有 AI 判斷需要人工時才有 finding。ESCALATED：AI 提出的疑慮一併交給人工。
  if (file.track === TRACK.AI_TRACK && ai.status !== 'NEEDS_HUMAN') return [];
  if (concerns.length === 0) {
    return file.track === TRACK.AI_TRACK
      ? numbered(file.path, [{ ...base, blocker: 'AI_NEEDS_HUMAN', anchor: 'AI_NEEDS_HUMAN', location: null, description: ai.summary }])
      : [];
  }
  return numbered(file.path, concerns.map((concern) => ({
    ...base,
    blocker: 'AI_CONCERN',
    anchor: compact(concern.title),
    location: concern.startLine > 0 ? { side: concern.side, startLine: concern.startLine, endLine: concern.endLine } : null,
    description: `${concern.title}：${concern.detail}`,
  })));
}
