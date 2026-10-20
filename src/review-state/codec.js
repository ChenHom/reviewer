import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 二次 review 狀態的編碼：以隱藏區塊放在置頂儀表板留言的最後。
 *
 * ```
 * <!-- reviewer:state v1 kid=<key id> sig=<HMAC-SHA256> -->
 * <!-- <base64(gzip(JSON))> -->
 * ```
 *
 * 有 write 權限的人都能編輯 bot 的留言，所以狀態以 HMAC 簽章。簽章對不上、key 不認得、版本不認得、
 * 解不開或形狀不對時一律丟棄（呼叫端從頭重算，結果只會更嚴格）。簽章在解壓縮之前檢查，
 * 未簽章的內容不會被解壓縮。換 key 時舊 key 放在 `previous`，仍可驗證舊狀態；寫出時一律用目前的 key。
 */

export const STATE_VERSION = 1;
/** 解壓縮後的上限（位元組）：狀態留言最多 65,536 字元，正常的狀態遠小於這個值。 */
const MAX_DECODED_BYTES = 1_000_000;
const BLOCK = /<!-- reviewer:state v(\d+) kid=([0-9a-z]+) sig=([0-9a-z]+) -->\r?\n<!-- ([A-Za-z0-9+/=]*) -->\s*$/;

/**
 * key 的識別碼（sha256 的前 8 碼），讓簽章可以指出用哪一把 key，key 本身不會出現在留言中。
 *
 * @param {string} key - HMAC key。
 * @returns {string} key id。
 */
export function keyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * 整理目前與舊的 key（舊的 key 以換行或逗號分隔）。空字串忽略。
 *
 * @param {string|undefined|null} current - 目前的 key（寫出時使用）。
 * @param {string|undefined|null} [previous] - 舊的 key（只用於驗證）。
 * @returns {{current: {id: string, key: string}|null, all: Array<{id: string, key: string}>}} key 集合。
 */
export function stateKeys(current, previous = '') {
  const entry = (key) => ({ id: keyId(key), key });
  const currentKey = typeof current === 'string' && current.trim() !== '' ? entry(current.trim()) : null;
  const others = String(previous ?? '').split(/[\n,]/).map((key) => key.trim()).filter((key) => key !== '').map(entry);
  return { current: currentKey, all: [...(currentKey ? [currentKey] : []), ...others] };
}

/**
 * 簽章：涵蓋版本、key id 與 payload。
 *
 * @param {string} key - HMAC key。
 * @param {string} kid - key id。
 * @param {string} payload - base64 payload。
 * @returns {string} hex 簽章。
 */
function sign(key, kid, payload) {
  return createHmac('sha256', key).update(`v${STATE_VERSION}.${kid}.${payload}`).digest('hex');
}

/**
 * 狀態編碼成隱藏區塊。沒有 key 時輸出未簽章的區塊（只供本機預覽；讀取時一律視為無效）。
 *
 * @param {object} state - 狀態。
 * @param {{id: string, key: string}|null} key - 目前的 key。
 * @returns {string} 隱藏區塊（兩行）。
 */
export function encodeState(state, key) {
  const payload = gzipSync(Buffer.from(JSON.stringify(state), 'utf8')).toString('base64');
  const kid = key ? key.id : 'unsigned';
  const sig = key ? sign(key.key, key.id, payload) : 'unsigned';
  return `<!-- reviewer:state v${STATE_VERSION} kid=${kid} sig=${sig} -->\n<!-- ${payload} -->`;
}

/**
 * 狀態的形狀檢查（只檢查之後的計算依賴的欄位）。
 *
 * @param {unknown} state - 解碼後的值。
 * @returns {boolean} 是否合法。
 */
function validShape(state) {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  return isObject(state)
    && state.version === STATE_VERSION
    && Number.isInteger(state.pullRequest)
    && Number.isInteger(state.nextShortId) && state.nextShortId >= 1
    && (state.lastProcessedCommentId === null || Number.isInteger(state.lastProcessedCommentId))
    && isObject(state.items)
    && Object.values(state.items).every((item) => isObject(item) && typeof item.shortId === 'string' && typeof item.state === 'string')
    && Array.isArray(state.heads)
    && state.heads.every((head) => isObject(head) && typeof head.sha === 'string' && isObject(head.items))
    && Array.isArray(state.acks)
    && state.acks.every((ack) => isObject(ack) && typeof ack.itemId === 'string' && typeof ack.scope === 'string' && typeof ack.policy === 'string');
}

/**
 * 從儀表板留言取出並驗證狀態。區塊必須在留言的最後（說明文字中出現的類似字串不算）。
 *
 * @param {string|null|undefined} body - 儀表板留言內容。
 * @param {object} options - 選項。
 * @param {Array<{id: string, key: string}>} options.keys - 可用於驗證的 key。
 * @param {number} options.pullRequest - PR 編號（狀態必須屬於這個 PR）。
 * @returns {{status: 'absent'|'valid'|'invalid', state: object|null, reason: string|null}} 結果。
 */
export function decodeState(body, { keys, pullRequest }) {
  const text = typeof body === 'string' ? body : '';
  const invalid = (reason) => ({ status: 'invalid', state: null, reason });
  const match = BLOCK.exec(text);
  if (!match) return text.includes('reviewer:state') ? invalid('STATE_MALFORMED') : { status: 'absent', state: null, reason: null };

  const [, version, kid, sig, payload] = match;
  if (Number(version) !== STATE_VERSION) return invalid('STATE_VERSION_UNKNOWN');
  if (kid === 'unsigned') return invalid('STATE_UNSIGNED');
  const key = keys.find((candidate) => candidate.id === kid);
  if (!key) return invalid('STATE_KEY_UNKNOWN');
  const expected = Buffer.from(sign(key.key, kid, payload), 'hex');
  const actual = Buffer.from(sig, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid('STATE_SIGNATURE_MISMATCH');

  let state;
  try {
    state = JSON.parse(gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: MAX_DECODED_BYTES }).toString('utf8'));
  } catch {
    return invalid('STATE_DECODE_FAILED');
  }
  if (!validShape(state)) return invalid('STATE_SHAPE_INVALID');
  // 簽章合法但屬於另一個 PR（複製別的 PR 的狀態）：不採用。
  if (state.pullRequest !== pullRequest) return invalid('STATE_PULL_REQUEST_MISMATCH');
  return { status: 'valid', state, reason: null };
}
