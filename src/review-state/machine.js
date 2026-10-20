import { createHash } from 'node:crypto';

import { DECISION } from '../contracts.js';
import { canonicalizeJsonValue } from '../facts/contracts.js';
import { MAX_REASON_CHARS, PERMISSION_RANK, ackMessage, editProblem, evaluateAck, isBotComment, parseCommands, permissionOf } from './commands.js';
import { STATE_VERSION } from './codec.js';

/**
 * 二次 review 的狀態機。每次都從頭重算：
 *
 * > 新狀態 = f(最新報表, 所有有效的確認)
 *
 * 狀態留言只保存短編號、各 head 的 fingerprint（驗證 `@sha` 用）與已驗證的確認，所以事件的處理順序
 * （push 與確認留言交錯）不影響結果。保存的確認每次都與目前的留言與權限核對（留言被刪除或編輯過、
 * 確認者的權限不足就不再採用），所以 `comments` 必須是 PR 的全部 issue comments，`permissions` 必須涵蓋確認者。
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
  if (file.ai?.status === 'FAILED' || aiFindings.some((finding) => finding.blocker === 'AI_REVIEW_FAILED')) return 'AI_REVIEW_FAILED';
  if (aiFindings.some((finding) => finding.blocker === 'AI_CONCERN')) return 'AI_CONCERN';
  if (aiFindings.length > 0 || file.ai?.status === 'NEEDS_HUMAN') return 'AI_NEEDS_HUMAN';
  // `--ai-apply` 的修正只寫入 worktree：報表的 head 仍是沒有修正的版本。
  if (file.ai?.status === 'FIXED') return 'AI_FIX_UNCOMMITTED';
  return ['AI_TRACK', 'ESCALATED'].includes(file.track) && !file.ai ? 'AI_REVIEW_MISSING' : 'HUMAN_REVIEW_REQUIRED';
}

/**
 * 檔案是否確定不需要人工：只有兩種已知的組合，其他（不認得的路由、欄位不一致或缺少）一律需要（fail-closed）。
 *
 * - 機械審查略過：`AUTO_PASS` 且決策是 `NOT_SELECTED_FOR_HUMAN_REVIEW`；
 * - AI 審查通過：`AI_TRACK`、決策是 `HUMAN_REVIEW_REQUIRED`（路由只對這個決策產生 `AI_TRACK`；其他決策要
 *   升級，AI 不能放行）、`needsHuman: false`，且 AI 的結果是 `PASS`。`FIXED`（`--ai-apply`）不算：
 *   修正只寫入 worktree，報表的 head 是沒有修正的版本，要 commit 後在新的 head 重新審查。
 *
 * @param {object} file - review file result。
 * @returns {boolean} 是否不需要人工。
 */
export function clearedFile(file) {
  if (file.track === 'AUTO_PASS') return file.decision === DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW && file.needsHuman !== true;
  if (file.track === 'AI_TRACK') return file.decision === DECISION.HUMAN_REVIEW_REQUIRED && file.needsHuman === false && file.ai?.status === 'PASS';
  return false;
}

/**
 * 有單向門的檔案，AI 是否放行了單向門以外的部分：只有一致的升級（`ESCALATED`、決策是 `HUMAN_REVIEW_REQUIRED`）
 * 且 AI 的結果是 `PASS`。不認得的決策也會被路由升級，但那是因為它的審查範圍不可信，AI 的結果不能放行。
 *
 * @param {object} file - review file result。
 * @returns {boolean} 是否放行。
 */
function aiClearedRest(file) {
  return file.track === 'ESCALATED' && file.decision === DECISION.HUMAN_REVIEW_REQUIRED && file.ai?.status === 'PASS';
}

/**
 * 報表中要追蹤的項目。
 *
 * @param {object} report - bin/review.js 的 JSON 報表。
 * @returns {Map<string, object>} id → item。
 */
export function buildItems(report) {
  const items = new Map();
  // 檔案層級的確認也綁定 AI 審查的依據：專案設定與 merge base 的 `codingstandards.md`。
  const filePolicy = fingerprint(digest(['file-review', report?.config?.digest ?? null, report?.ai?.standards?.digest ?? null]));
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
    // 需要人工的檔案一定要有項目可以確認（fail-closed）：
    // - AI 的 finding；
    // - 沒有單向門、又不確定不需要人工的檔案；
    // - 有單向門，但 AI 沒有放行單向門以外的部分（沒有 AI 審查、AI 失敗、AI 判斷需要人工，或路由與決策不一致）：
    //   確認單向門不代表看過整個檔案。
    if (aiFindings.length > 0 || (doors.length === 0 ? !clearedFile(file) : !aiClearedRest(file))) {
      const id = digest(['file-review', file.path]);
      items.set(id, {
        id,
        kind: 'FILE',
        path: file.path,
        subject: file.path,
        blocker: fileBlocker(file, aiFindings),
        description: aiFindings.map((finding) => finding.description).filter(Boolean).join('；')
          || (file.ai?.status === 'FAILED' ? file.ai.error : (file.ai?.fix?.description || file.ai?.summary)) || null,
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
  const kindOrder = (item) => (item.kind === 'FILE' ? 1 : 0);
  return left.path.localeCompare(right.path)
    || kindOrder(left) - kindOrder(right)
    || (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0)
    || left.id.localeCompare(right.id);
}

/**
 * 顯示編號中 id 前綴的長度：至少 4 碼，加長到所有已知項目都不重複。
 *
 * @param {Iterable<string>} ids - 所有已知項目的 id。
 * @returns {number} 長度。
 */
export function labelLength(ids) {
  const list = [...new Set(ids)];
  for (let length = 4; length < 64; length += 1) {
    if (new Set(list.map((id) => id.slice(0, length))).size === list.length) return length;
  }
  return 64;
}

/**
 * 項目的顯示編號（短編號 + id 前綴，預設 4 碼；與其他項目重複時 computeState() 會加長）。
 *
 * @param {{shortId: string, id: string, labelLength?: number}} item - 項目。
 * @returns {string} 例如 `F1-3fa2`。
 */
export function itemLabel(item) {
  return `${item.shortId}-${item.id.slice(0, item.labelLength ?? 4)}`;
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
  const prefixLength = labelLength(known.keys());
  const ordered = [...comments].filter((comment) => Number.isInteger(comment?.id)).sort((left, right) => left.id - right.id);
  // 保存的確認每次都重新檢查：指令留言被刪除、被編輯過或作者不符，確認者是 PR 作者，或確認者目前的權限
  // 低於現在的門檻（權限被移除、`--ack-permission` 提高）時，這個確認不再採用。
  const byId = new Map(ordered.map((comment) => [comment.id, comment]));
  const standing = (ack) => {
    const source = byId.get(ack.commentId);
    const login = String(ack.login ?? '').toLowerCase();
    const permission = permissionOf(permissions, login);
    return Boolean(source)
      && !isBotComment(source)
      && editProblem(source) === null
      && String(source.user?.login ?? '').toLowerCase() === login
      && login !== String(pr.login ?? '').toLowerCase()
      && permission !== null && PERMISSION_RANK[permission] >= PERMISSION_RANK[minPermission];
  };
  const acks = (prior?.acks ?? []).filter(standing);
  const withdrawn = (prior?.acks?.length ?? 0) - acks.length;
  const replies = [];
  const lastProcessed = prior?.lastProcessedCommentId ?? null;
  let maxCommentId = lastProcessed;
  let replayed = 0;
  let replayRejected = 0;
  const context = { pr, permissions, minPermission, known, current: snapshot(current), heads, checkShortId: !replay, replay, headSha };

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
      const label = result.itemId ? itemLabel({ id: result.itemId, shortId: shortIds.get(result.itemId), labelLength: prefixLength }) : command.shortId;
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

  // 修正後再次出現：之前的確認針對的是修正前的那一次，不再採用（設計：FIXED → 再次出現 → REOPENED），
  // 即使 fingerprint 相同。這次執行才收到的確認保留。
  const reappeared = new Set(Object.entries(stateItems)
    .filter(([id, item]) => item.state === ITEM_STATE.FIXED && current.has(id))
    .map(([id]) => id));
  const kept = acks.filter((ack) => !reappeared.has(ack.itemId) || (lastProcessed !== null && ack.commentId > lastProcessed));

  // 每個項目的狀態。
  const items = [];
  for (const item of current.values()) {
    const shortId = shortIds.get(item.id);
    const itemAcks = kept.filter((ack) => ack.itemId === item.id);
    const valid = itemAcks.filter((ack) => ack.scope === item.scope && ack.policy === item.policy);
    const before = stateItems[item.id];
    let state = ITEM_STATE.OPEN;
    let reopenedBecause = null;
    if (valid.length > 0) {
      state = ITEM_STATE.ACKNOWLEDGED;
    } else if (itemAcks.length > 0 && !reappeared.has(item.id)) {
      state = ITEM_STATE.REOPENED;
      reopenedBecause = itemAcks.some((ack) => ack.scope !== item.scope) ? 'CODE_CHANGED' : 'POLICY_CHANGED';
    } else if (reappeared.has(item.id)) {
      state = ITEM_STATE.REOPENED;
      reopenedBecause = 'REAPPEARED';
    } else if (before && before.state === ITEM_STATE.REOPENED) {
      state = ITEM_STATE.REOPENED;
      reopenedBecause = before.reopenedBecause ?? 'REAPPEARED';
    }
    items.push({ ...item, shortId, labelLength: prefixLength, state, reopenedBecause, acks: valid, firstSeenSha: before?.firstSeenSha ?? headSha });
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
      labelLength: prefixLength,
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
    acks: kept,
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
