import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { decodeState, encodeState, keyId, stateKeys } from '../../src/review-state/codec.js';

const state = (overrides = {}) => ({
  version: 1,
  pullRequest: 42,
  headSha: 'a'.repeat(40),
  lastProcessedCommentId: null,
  nextShortId: 2,
  items: { abc: { shortId: 'F1', state: 'OPEN' } },
  heads: [{ sha: 'a'.repeat(40), items: { F1: 'x:y' } }],
  acks: [],
  ...overrides,
});
const keys = stateKeys('current-key', 'old-1\nold-2, old-3');
const dashboard = (block) => `<!-- reviewer:dashboard v1 -->\n## 標題\n\n${block}`;
const decode = (body, pullRequest = 42, all = keys.all) => decodeState(body, { keys: all, pullRequest });
/** 用指定的 key 簽一個任意 payload（測試簽章合法但內容不對的情況）。 */
const signed = (payload, key = 'current-key') => {
  const kid = keyId(key);
  const sig = createHmac('sha256', key).update(`v1.${kid}.${payload}`).digest('hex');
  return `<!-- reviewer:state v1 kid=${kid} sig=${sig} -->\n<!-- ${payload} -->`;
};

test('stateKeys：目前的 key 在前，舊的 key 以換行或逗號分隔，空字串忽略', () => {
  assert.deepEqual(keys.all.map(({ key }) => key), ['current-key', 'old-1', 'old-2', 'old-3']);
  assert.equal(keys.current.id, keyId('current-key'));
  assert.match(keyId('x'), /^[0-9a-f]{8}$/);
  assert.deepEqual(stateKeys('', '  ').all, []);
  assert.equal(stateKeys(undefined).current, null);
  assert.deepEqual(stateKeys(null, null).all, []);
});

test('encode / decode：簽章合法時取回狀態；舊的 key 也能驗證', () => {
  const block = encodeState(state(), keys.current);
  assert.deepEqual(decode(dashboard(block)), { status: 'valid', state: state(), reason: null });
  // 結尾多出空白或 CRLF 也可以。
  assert.equal(decode(`${dashboard(block)}\n\n`).status, 'valid');
  assert.equal(decode(dashboard(block.replace('\n', '\r\n'))).status, 'valid');

  const old = stateKeys('old-2');
  assert.equal(decode(dashboard(encodeState(state(), old.current))).status, 'valid');
});

test('decode：沒有狀態、被竄改、key 不認得、未簽章、版本不認得或屬於其他 PR 時不採用', () => {
  assert.deepEqual(decode(null), { status: 'absent', state: null, reason: null });
  assert.deepEqual(decode('只有文字'), { status: 'absent', state: null, reason: null });
  assert.equal(decode('<!-- reviewer:state 壞掉 -->').reason, 'STATE_MALFORMED');

  const block = encodeState(state(), keys.current);
  const payload = /<!-- ([A-Za-z0-9+/=]+) -->$/.exec(block)[1];
  const tampered = block.replace(payload, encodeState(state({ acks: [{ itemId: 'abc', scope: 'x', policy: 'y' }] }), null).split('\n')[1].slice(5, -4));
  assert.equal(decode(dashboard(tampered)).reason, 'STATE_SIGNATURE_MISMATCH');
  assert.equal(decode(dashboard(block.replace(/sig=[0-9a-f]+/, 'sig=00'))).reason, 'STATE_SIGNATURE_MISMATCH');
  assert.equal(decode(dashboard(encodeState(state(), stateKeys('unknown').current))).reason, 'STATE_KEY_UNKNOWN');
  assert.equal(decode(dashboard(encodeState(state(), null))).reason, 'STATE_UNSIGNED');
  assert.equal(decode(dashboard(block.replace('state v1', 'state v2'))).reason, 'STATE_VERSION_UNKNOWN');
  assert.equal(decode(dashboard(block), 43).reason, 'STATE_PULL_REQUEST_MISMATCH');
  // 沒有 key 時一律無法驗證。
  assert.equal(decode(dashboard(block), 42, []).reason, 'STATE_KEY_UNKNOWN');
});

test('decode：區塊必須在留言最後；說明文字中出現的區塊不算', () => {
  const block = encodeState(state(), keys.current);
  assert.equal(decode(`${dashboard(block)}\n\n後面還有文字`).reason, 'STATE_MALFORMED');
});

test('decode：簽章合法但內容解不開或形狀不對時不採用', () => {
  assert.equal(decode(dashboard(signed(Buffer.from('not gzip').toString('base64')))).reason, 'STATE_DECODE_FAILED');
  const json = (value) => gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');
  assert.equal(decode(dashboard(signed(json({ hello: 'world' })))).reason, 'STATE_SHAPE_INVALID');
  for (const broken of [
    state({ version: 2 }),
    state({ nextShortId: 0 }),
    state({ lastProcessedCommentId: 'x' }),
    state({ items: [] }),
    state({ items: { a: { shortId: 1, state: 'OPEN' } } }),
    state({ heads: {} }),
    state({ heads: [{ sha: 1, items: {} }] }),
    state({ acks: [{ itemId: 'a' }] }),
    [],
  ]) {
    assert.equal(decode(dashboard(signed(json(broken)))).reason, 'STATE_SHAPE_INVALID', JSON.stringify(broken));
  }
  assert.equal(decode(dashboard(signed(json(state({ lastProcessedCommentId: 7 }))))).status, 'valid');
});
