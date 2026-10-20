import { createHash } from 'node:crypto';

import { canonicalizeJsonValue } from '../facts/contracts.js';
import { MAX_REASON_CHARS, ackMessage, evaluateAck, isBotComment, parseCommands } from './commands.js';
import { STATE_VERSION } from './codec.js';

/**
 * 二次 review 的狀態機。每次都從頭重算：
 *
 * > 新狀態 = f(最新報表, 所有有效的確認)
 *
 * 狀態留言只保存短編號、各 head 的 fingerprint（驗證 `@sha` 用）與已驗證的確認，所以事件的處理順序
 * （push 與確認留言交錯）不影響結果。保存的確認每次都與目前的留言核對（留言被刪除或編輯過就不再採用），
 * 所以 `comments` 必須是 PR 的全部 issue comments。
 *
 * 追蹤的項目（item）：
 * - `DOOR`：機械審查的單向門 finding（`files[].findings` 中 `kind` 不是 `AI` 的），各自確認，
 *   綁定所屬 method 的局部 AST hash 與產生 blocker 的規則。
 * - `FILE`：以檔案為單位的人工確認：AI 判斷需要人工、AI 審查失敗、AI 提出的疑慮，以及需要人工但沒有任何
 *   finding 的檔案（例如沒有執行 AI 審查）。AI 的輸出不是 deterministic 的，逐條確認會在每次重跑時失效，
 *   所以一次確認整個檔案目前的內容（git blob id），檔案一改就重新開啟。
 *
 * 狀態：`OPEN`（待確認）、`ACKNOWLEDGED`（有效確認）、`REOPENED`（確認後程式碼或規則改變，或修正後再次出現）、
 * `FIXED`（目前的 head 已經沒有）。`OPEN` / `REOPENED` 會讓 Check 失敗。
 */

export const ITEM_STATE = Object.freeze({ OPEN: 'OPEN', ACKNOWLEDGED: 'ACKNOWLEDGED', REOPENED: 'REOPENED', FIXED: 'FIXED' });
/** 狀態中保留的 head 數（驗證 `@sha` 用）。 */
export const MAX_HEADS = 10;

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
 * 狀態中保存的 fingerprint（sha256 前 32 碼）：比對 scope hash 與 policy digest 用，縮短狀態留言。
 *
 * @param {unknown} value - 值。
 * @returns {string} fingerprint。
 */
export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * 檔案層級項目的原因。
 *
 * @param {object} file - review file result。
 * @param {object[]} aiFindings - 這個檔案的 AI finding。
 * @returns {string} 原因代碼。
 */
function fileBlocker(file, aiFindings) {
  if (aiFindings.some((finding) => finding.blocker === 'AI_REVIEW_FAILED')) return 'AI_REVIEW_FAILED';
  if (aiFindings.some((finding) => finding.blocker === 'AI_CONCERN')) return 'AI_CONCERN';
  if (aiFindings.length > 0) return 'AI_NEEDS_HUMAN';
  return file.track === 'AI_TRACK' && !file.ai ? 'AI_REVIEW_MISSING' : 'HUMAN_REVIEW_REQUIRED';
}

/**
 * 報表中要追蹤的項目。
 *
 * @param {object} report - bin/review.js 的 JSON 報表。
 * @returns {Map<string, object>} id → item。
 */
export function buildItems(report) {
  const items = new Map();
  const filePolicy = fingerprint(digest(['file-review', report?.config?.digest ?? null]));
  for (const file of report?.files ?? []) {
    const findings = file.findings ?? [];
    const doors = findings.filter((finding) => finding.kind !== 'AI');
    const aiFindings = findings.filter((finding) => finding.kind === 'AI');
    for (const finding of doors) {
      items.set(finding.id, {
        id: finding.id,
        kind: 'DOOR',
        path: file.path,
        subject: finding.subject ?? file.path,
        blocker: finding.blocker,
        description: finding.description ?? null,
        location: finding.location ?? null,
        scope: fingerprint(finding.scopeHash ?? file.contentHash),
        policy: fingerprint(finding.policyDigest ?? digest(['blocker', finding.blocker, null])),
      });
    }
    // 需要人工的檔案一定要有項目可以確認（fail-closed）：AI 的 finding 或沒有任何 finding 時以檔案為單位。
    if (aiFindings.length > 0 || (file.needsHuman !== false && file.track !== 'AUTO_PASS' && doors.length === 0)) {
      const id = digest(['file-review', file.path]);
      items.set(id, {
        id,
        kind: 'FILE',
        path: file.path,
        subject: file.path,
        blocker: fileBlocker(file, aiFindings),
        description: aiFindings.map((finding) => finding.description).filter(Boolean).join('；') || null,
        concerns: aiFindings.length,
        location: null,
        scope: fingerprint(file.contentHash),
        policy: filePolicy,
      });
    }
  }
  return items;
}

/**
 * 項目的 fingerprint（某個 head 的 scope / policy）。
 *
 * @param {Map<string, object>} items - 項目。
 * @returns {Map<string, {scope: string, policy: string}>} id → fingerprint。
 */
function snapshot(items) {
  return new Map([...items.values()].map((item) => [item.id, { scope: item.scope, policy: item.policy }]));
}

/**
 * 狀態中保存的 heads 轉成 head → 項目 id → fingerprint（狀態以短編號保存，節省空間）。
 *
 * @param {object|null} state - 已驗證的狀態。
 * @returns {Map<string, Map<string, {scope: string, policy: string}>>} heads。
 */
function stateHeads(state) {
  const byShortId = new Map(Object.entries(state?.items ?? {}).map(([id, item]) => [item.shortId, id]));
  return new Map((state?.heads ?? []).map((head) => [head.sha, new Map(Object.entries(head.items)
    .filter(([shortId]) => byShortId.has(shortId))
    .map(([shortId, value]) => {
      const [scope, policy] = String(value).split(':');
      return [byShortId.get(shortId), { scope, policy }];
    }))]));
}

/**
 * 依路徑、行號與 id 排序（短編號的配發順序與顯示順序）。
 *
 * @param {object} left - 項目。
 * @param {object} right - 項目。
 * @returns {number} 比較結果。
 */
export function compareItems(left, right) {
  return left.path.localeCompare(right.path)
    || (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0)
    || left.id.localeCompare(right.id);
}

/**
 * 項目的顯示編號（短編號 + id 前 4 碼）。
 *
 * @param {{shortId: string, id: string}} item - 項目。
 * @returns {string} 例如 `F1-3fa2`。
 */
export function itemLabel(item) {
  return `${item.shortId}-${item.id.slice(0, 4)}`;
}

/**
 * 重算狀態。
 *
 * @param {object} options - 輸入。
 * @param {object} options.report - 目前 head 的報表（`bin/review.js --out`）。
 * @param {{status: string, state: object|null}} options.previous - decodeState() 的結果。
 * @param {object[]} [options.comments=[]] - PR 的全部 issue comments（GitHub REST 形狀）。
 * @param {{number: number, login: string}} options.pr - PR 編號與作者。
 * @param {object} [options.permissions={}] - login → 權限。
 * @param {string} [options.minPermission='write'] - 確認所需的最低權限。
 * @param {object[]} [options.history=[]] - 之前 head 的報表（狀態遺失時驗證 `@sha` 用）。
 * @returns {object} `{ state, items, replies, notes, replay }`：`items` 含目前與已修正的項目及狀態。
 */
export function computeState({ report, previous, comments = [], pr, permissions = {}, minPermission = 'write', history = [] }) {
  const prior = previous?.status === 'valid' ? previous.state : null;
  // 有過儀表板但狀態無法驗證：從頭重播所有確認留言，不逐則回覆（避免洗版），在儀表板說明。
  const replay = previous?.status === 'invalid';
  const headSha = report.head.sha;
  const current = buildItems(report);

  // 短編號：沿用狀態中的，新的項目依序配發（永不重用）。
  const stateItems = prior?.items ?? {};
  let nextShortId = prior?.nextShortId ?? 1;
  const shortIds = new Map(Object.entries(stateItems).map(([id, item]) => [id, item.shortId]));
  for (const item of [...current.values()].sort(compareItems)) {
    if (!shortIds.has(item.id)) {
      shortIds.set(item.id, `F${nextShortId}`);
      nextShortId += 1;
    }
  }

  // 各 head 的 fingerprint：狀態中保存的、之前的報表，以及目前的報表。
  const heads = stateHeads(prior);
  for (const old of history) {
    if (typeof old?.head?.sha === 'string' && !heads.has(old.head.sha)) heads.set(old.head.sha, snapshot(buildItems(old)));
  }
  heads.delete(headSha);
  heads.set(headSha, snapshot(current));

  const known = new Map([...shortIds].map(([id, shortId]) => [id, { shortId }]));
  const ordered = [...comments].filter((comment) => Number.isInteger(comment?.id)).sort((left, right) => left.id - right.id);
  // 保存的確認每次都與目前的留言核對：指令留言被刪除、被編輯過或作者不符時，這個確認不再採用。
  const byId = new Map(ordered.map((comment) => [comment.id, comment]));
  const standing = (ack) => {
    const source = byId.get(ack.commentId);
    return Boolean(source)
      && !isBotComment(source)
      && (source.updated_at === undefined || source.updated_at === source.created_at)
      && String(source.user?.login ?? '').toLowerCase() === String(ack.login ?? '').toLowerCase();
  };
  const acks = (prior?.acks ?? []).filter(standing);
  const withdrawn = (prior?.acks?.length ?? 0) - acks.length;
  const replies = [];
  const lastProcessed = prior?.lastProcessedCommentId ?? null;
  let maxCommentId = lastProcessed;
  let replayed = 0;
  let replayRejected = 0;
  const context = { pr, permissions, minPermission, known, current: snapshot(current), heads, checkShortId: !replay };

  for (const comment of ordered) {
    if (lastProcessed !== null && comment.id <= lastProcessed) continue;
    maxCommentId = Math.max(maxCommentId ?? 0, comment.id);
    if (isBotComment(comment)) continue;
    const messages = [];
    for (const command of parseCommands(comment.body)) {
      if (command.kind !== 'ack') {
        messages.push(ackMessage('ACK_FORMAT_INVALID'));
        continue;
      }
      const result = evaluateAck(command, comment, context);
      const label = result.itemId ? itemLabel({ id: result.itemId, shortId: shortIds.get(result.itemId) }) : command.shortId;
      messages.push(ackMessage(result.code, { label, sha: result.sha ?? command.sha, minPermission }));
      if (replay) {
        replayed += 1;
        if (!result.accepted) replayRejected += 1;
      }
      if (!result.accepted) continue;
      const fingerprints = context.current.get(result.itemId);
      const duplicate = acks.some((ack) => ack.itemId === result.itemId && ack.scope === fingerprints.scope
        && ack.policy === fingerprints.policy && ack.login.toLowerCase() === comment.user.login.toLowerCase());
      if (duplicate) continue;
      acks.push({
        itemId: result.itemId,
        login: comment.user.login,
        userId: comment.user.id ?? null,
        sha: result.sha,
        scope: fingerprints.scope,
        policy: fingerprints.policy,
        commentId: comment.id,
        at: comment.created_at ?? null,
        reason: command.reason.slice(0, MAX_REASON_CHARS),
      });
    }
    if (messages.length > 0 && !replay) replies.push({ commentId: comment.id, body: messages.join('\n') });
  }

  // 每個項目的狀態。
  const items = [];
  for (const item of current.values()) {
    const shortId = shortIds.get(item.id);
    const itemAcks = acks.filter((ack) => ack.itemId === item.id);
    const valid = itemAcks.filter((ack) => ack.scope === item.scope && ack.policy === item.policy);
    const before = stateItems[item.id];
    let state = ITEM_STATE.OPEN;
    let reopenedBecause = null;
    if (valid.length > 0) {
      state = ITEM_STATE.ACKNOWLEDGED;
    } else if (itemAcks.length > 0) {
      state = ITEM_STATE.REOPENED;
      reopenedBecause = itemAcks.some((ack) => ack.scope !== item.scope) ? 'CODE_CHANGED' : 'POLICY_CHANGED';
    } else if (before && [ITEM_STATE.FIXED, ITEM_STATE.REOPENED].includes(before.state)) {
      state = ITEM_STATE.REOPENED;
      reopenedBecause = before.reopenedBecause ?? 'REAPPEARED';
    }
    items.push({ ...item, shortId, state, reopenedBecause, acks: valid, firstSeenSha: before?.firstSeenSha ?? headSha });
  }
  for (const [id, before] of Object.entries(stateItems)) {
    if (current.has(id)) continue;
    items.push({
      id,
      kind: before.kind ?? 'DOOR',
      path: before.path ?? '',
      subject: before.subject ?? before.path ?? '',
      blocker: before.blocker ?? '',
      description: null,
      location: null,
      shortId: before.shortId,
      state: ITEM_STATE.FIXED,
      reopenedBecause: null,
      acks: [],
      firstSeenSha: before.firstSeenSha ?? null,
    });
  }
  items.sort(compareItems);

  const notes = [];
  if (withdrawn > 0) notes.push({ code: 'ACKS_WITHDRAWN', count: withdrawn });
  if (replay) {
    notes.push({
      code: 'STATE_RESET',
      reason: previous.reason,
      replayed,
      rejected: replayRejected,
    });
  }

  const state = {
    version: STATE_VERSION,
    pullRequest: pr.number,
    headSha,
    lastProcessedCommentId: maxCommentId,
    nextShortId,
    items: Object.fromEntries(items.map((item) => [item.id, {
      shortId: item.shortId,
      kind: item.kind,
      state: item.state,
      blocker: item.blocker,
      path: item.path,
      subject: item.subject,
      firstSeenSha: item.firstSeenSha,
      ...(item.reopenedBecause ? { reopenedBecause: item.reopenedBecause } : {}),
    }])),
    // 最新的 head 在最後；以短編號保存。
    heads: [...heads].slice(-MAX_HEADS).map(([sha, values]) => ({
      sha,
      items: Object.fromEntries([...values]
        .filter(([id]) => shortIds.has(id))
        .map(([id, value]) => [shortIds.get(id), `${value.scope}:${value.policy}`])),
    })),
    acks,
  };
  return { state, items, replies, notes, replay };
}

/**
 * Check 的結論：有待確認（`OPEN` / `REOPENED`）的項目就失敗。Check 綁定報表的 head。
 *
 * @param {object} report - 報表。
 * @param {object[]} items - computeState() 的 items。
 * @returns {{headSha: string, conclusion: 'success'|'failure', title: string, pending: number}} Check。
 */
export function checkResult(report, items) {
  const pending = items.filter((item) => [ITEM_STATE.OPEN, ITEM_STATE.REOPENED].includes(item.state)).length;
  const acknowledged = items.filter((item) => item.state === ITEM_STATE.ACKNOWLEDGED).length;
  let title = '不需要人工確認';
  if (pending > 0) title = `需要人工確認 ${pending} 項`;
  else if (acknowledged > 0) title = `人工確認完成（${acknowledged} 項）`;
  return { headSha: report.head.sha, conclusion: pending > 0 ? 'failure' : 'success', title, pending };
}
