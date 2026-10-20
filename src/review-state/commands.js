/**
 * 人工豁免指令：`/reviewer ack F1-3fa2@a1b2c3d <理由>`。
 *
 * - `F1` 是儀表板的短編號，`3fa2` 是 finding id 的前綴（至少 4 碼）。狀態遺失後短編號會重新配發，
 *   所以以 id 前綴找項目；前綴對應到多個項目時再以短編號縮小範圍，短編號也用來防止打錯。
 * - `@a1b2c3d` 是確認者看到的 head（至少 7 碼）。該項目在那個 head 的局部 AST hash 與規則必須等於目前的，
 *   否則代表看完之後程式碼或規則又改了，拒絕並要求重看。
 * - 每一行先做 NFKC 正規化（中文輸入法的全形 `＠`、全形空白、全形英數字視為半形）。
 * - 引用（`>` 開頭）、程式碼區塊與縮排程式碼中的指令不算：引用別人的指令不等於自己確認。
 */

export const ACK_USAGE = '/reviewer ack <編號>@<head> <理由>（例如 `/reviewer ack F1-3fa2@a1b2c3d 已確認改由呼叫端包 transaction`）';
/** 單一留言最多處理的指令數。 */
const MAX_COMMANDS = 20;
/** 理由保留的最大長度（字元）。 */
export const MAX_REASON_CHARS = 200;
const COMMAND = /^\/reviewer(?:\s|$)/i;
const ACK = /^\/reviewer\s+ack\s+f(\d+)-([0-9a-f]{4,64})@([0-9a-f]{7,40})(?:\s+(.*))?$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export const PERMISSION_RANK = Object.freeze({ none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 });

/**
 * 留言中的指令（依出現順序）。格式錯誤的 `/reviewer` 行也列出（`kind: 'invalid'`），讓呼叫端回覆正確格式。
 *
 * @param {string} body - 留言內容。
 * @returns {Array<{kind: 'ack', shortId: string, idPrefix: string, sha: string, reason: string}|{kind: 'invalid', line: string}>} 指令。
 */
export function parseCommands(body) {
  const commands = [];
  let fence = null;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    // 程式碼區塊、縮排程式碼與引用中的指令不算。
    if (fence !== null || /^(?: {4}|\t)/.test(raw) || /^ {0,3}>/.test(raw)) continue;
    const line = raw.normalize('NFKC').trim();
    if (!COMMAND.test(line)) continue;
    const match = ACK.exec(line);
    commands.push(match
      ? { kind: 'ack', shortId: `F${Number(match[1])}`, idPrefix: match[2].toLowerCase(), sha: match[3].toLowerCase(), reason: (match[4] ?? '').trim() }
      : { kind: 'invalid', line });
    if (commands.length >= MAX_COMMANDS) break;
  }
  return commands;
}

/**
 * 留言者是否為 bot（bot 的留言一律忽略，包括 reviewer 自己的儀表板）。
 *
 * @param {object} comment - GitHub issue comment。
 * @returns {boolean} 是否為 bot。
 */
export function isBotComment(comment) {
  const login = String(comment?.user?.login ?? '');
  return comment?.user?.type === 'Bot' || /\[bot\]$/i.test(login);
}

/**
 * 留言者的權限（`permissions` 的值可以是字串或 GitHub 的 `{ role_name, permission }`）。`role_name` 是
 * 自訂角色的名稱時（不是標準權限），改用 `permission` 的標準權限。沒有資料或不認得時為 null。
 * 只認 `PERMISSION_RANK` 自己的 key（`constructor` 等 prototype 上的名稱不算）。
 *
 * @param {object} permissions - login → 權限。
 * @param {string} login - 留言者。
 * @returns {string|null} 權限名稱。
 */
export function permissionOf(permissions, login) {
  const entry = Object.entries(permissions ?? {}).find(([name]) => name.toLowerCase() === login.toLowerCase())?.[1];
  const candidates = typeof entry === 'string' ? [entry] : [entry?.role_name, entry?.permission];
  return candidates.find((value) => typeof value === 'string' && Object.hasOwn(PERMISSION_RANK, value)) ?? null;
}

/**
 * 以前綴找出唯一的值。
 *
 * @param {Iterable<string>} values - 候選。
 * @param {string} prefix - 前綴。
 * @returns {{value: string|null, ambiguous: boolean}} 結果。
 */
function uniquePrefix(values, prefix) {
  const matches = [...new Set([...values].filter((value) => value.startsWith(prefix)))];
  return { value: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

/**
 * 驗證一個 ack 指令。依序檢查：留言未被編輯、不是 PR 作者、權限、理由、項目、head、程式碼與規則沒有改變。
 *
 * @param {object} command - parseCommands() 的 ack 指令。
 * @param {object} comment - GitHub issue comment（`id`、`user`、`created_at`、`updated_at`）。
 * @param {object} context - 驗證所需的資料。
 * @param {{login: string}} context.pr - PR（作者）。
 * @param {object} context.permissions - login → 權限。
 * @param {string} context.minPermission - 最低權限。
 * @param {Map<string, object>} context.known - 所有已知的項目（目前的與狀態中的）：id → `{ shortId }`。
 * @param {Map<string, object>} context.current - 目前 head 的項目：id → `{ scope, policy }`。
 * @param {Map<string, Map<string, {scope: string, policy: string}>>} context.heads - head → 項目 id → 當時的 fingerprint。
 * @param {boolean} context.checkShortId - 是否檢查短編號（狀態遺失後重播時不檢查）。
 * @returns {{accepted: boolean, code: string, itemId: string|null, sha: string|null}} 結果。
 */
export function evaluateAck(command, comment, context) {
  const reject = (code, itemId = null, sha = null) => ({ accepted: false, code, itemId, sha });
  const login = String(comment?.user?.login ?? '');
  if (comment.updated_at !== undefined && comment.updated_at !== comment.created_at) return reject('ACK_EDITED');
  if (login === '' || login.toLowerCase() === String(context.pr.login ?? '').toLowerCase()) return reject('ACK_BY_AUTHOR');
  const permission = permissionOf(context.permissions, login);
  if (permission === null) return reject('ACK_PERMISSION_UNKNOWN');
  if (PERMISSION_RANK[permission] < PERMISSION_RANK[context.minPermission]) return reject('ACK_PERMISSION_DENIED');
  if (command.reason === '') return reject('ACK_REASON_MISSING');

  // id 前綴對應到多個項目時，再以短編號縮小範圍（狀態遺失後重播時短編號不可靠，不縮小）。
  const matches = [...context.known.keys()].filter((id) => id.startsWith(command.idPrefix));
  if (matches.length === 0) return reject('ACK_ITEM_UNKNOWN');
  const narrowed = matches.length > 1 && context.checkShortId
    ? matches.filter((id) => context.known.get(id).shortId === command.shortId)
    : matches;
  if (narrowed.length !== 1) return reject('ACK_ID_AMBIGUOUS');
  const itemId = narrowed[0];
  if (context.checkShortId && context.known.get(itemId).shortId !== command.shortId) return reject('ACK_SHORT_ID_MISMATCH', itemId);
  const current = context.current.get(itemId);
  if (!current) return reject('ACK_ITEM_FIXED', itemId);

  const head = uniquePrefix(context.heads.keys(), command.sha);
  if (head.ambiguous) return reject('ACK_SHA_AMBIGUOUS', itemId);
  if (head.value === null) return reject('ACK_SHA_UNKNOWN', itemId);
  const seen = context.heads.get(head.value).get(itemId);
  if (!seen) return reject('ACK_ITEM_NOT_AT_SHA', itemId, head.value);
  if (seen.scope !== current.scope) return reject('ACK_CODE_CHANGED', itemId, head.value);
  if (seen.policy !== current.policy) return reject('ACK_POLICY_CHANGED', itemId, head.value);
  return { accepted: true, code: 'ACK_ACCEPTED', itemId, sha: head.value };
}

/**
 * 回覆的說明文字。
 *
 * @param {string} code - evaluateAck() 的結果代碼，或 `ACK_FORMAT_INVALID`。
 * @param {object} details - 顯示用資料。
 * @param {string} [details.label] - 項目的顯示編號（`F1-3fa2`）。
 * @param {string} [details.sha] - head。
 * @param {string} [details.minPermission] - 最低權限。
 * @returns {string} 說明。
 */
export function ackMessage(code, { label = '', sha = '', minPermission = 'write' } = {}) {
  const short = sha.slice(0, 7);
  switch (code) {
    case 'ACK_ACCEPTED':
      return `✅ 已確認 ${label}（head \`${short}\`）。之後該處程式碼或相關規則再改變時會重新開啟。`;
    case 'ACK_FORMAT_INVALID':
      return `⚠️ 指令格式不對，請用：${ACK_USAGE}`;
    case 'ACK_EDITED':
      return '⚠️ 指令留言被編輯過，不採用。請重新留言。';
    case 'ACK_BY_AUTHOR':
      return '⚠️ PR 作者不能確認自己的變更，請由其他人確認。';
    case 'ACK_PERMISSION_UNKNOWN':
      return '⚠️ 無法確認留言者的權限，這個確認不採用。';
    case 'ACK_PERMISSION_DENIED':
      return `⚠️ 需要 ${minPermission} 以上的權限才能確認。`;
    case 'ACK_REASON_MISSING':
      return `⚠️ 請附上確認的理由：${ACK_USAGE}`;
    case 'ACK_ID_AMBIGUOUS':
      return '⚠️ 編號後面的 id 前綴對應到多個項目，請照儀表板複製完整編號。';
    case 'ACK_ITEM_UNKNOWN':
      return '⚠️ 找不到這個項目，請照儀表板複製編號。';
    case 'ACK_SHORT_ID_MISMATCH':
      return `⚠️ 編號與 id 前綴不一致（目前是 ${label}），請照儀表板複製編號。`;
    case 'ACK_ITEM_FIXED':
      return `${label} 在目前的 head 已經不存在（已修正），不需要確認。`;
    case 'ACK_SHA_AMBIGUOUS':
    case 'ACK_SHA_UNKNOWN':
      return '⚠️ `@` 後面的 head 不是 reviewer 分析過的 commit，請照儀表板顯示的 head 確認。';
    case 'ACK_ITEM_NOT_AT_SHA':
      return `⚠️ ${label} 在 head \`${short}\` 時還不存在，請以儀表板目前的 head 確認。`;
    case 'ACK_CODE_CHANGED':
      return `⚠️ head \`${short}\` 之後 ${label} 所在的程式碼又改了，請看過最新的變更後，以目前的 head 重新確認。`;
    case 'ACK_POLICY_CHANGED':
      return `⚠️ head \`${short}\` 之後產生 ${label} 的規則已更新，請以目前的 head 重新確認。`;
    default:
      return `⚠️ 這個確認不採用（${code}）。`;
  }
}
