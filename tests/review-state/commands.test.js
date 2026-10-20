import test from 'node:test';
import assert from 'node:assert/strict';

import { ACK_USAGE, ackMessage, evaluateAck, isBotComment, parseCommands, permissionOf } from '../../src/review-state/commands.js';

const ITEM = '3fa2'.padEnd(64, '0');
const OTHER = '3fa9'.padEnd(64, '1');
const SHA = 'a1b2c3d4'.padEnd(40, '0');

test('parseCommands：ack 指令、格式錯誤的 /reviewer 行；一般文字忽略', () => {
  assert.deepEqual(parseCommands('看過了\n/reviewer ack F1-3fa2@a1b2c3d 已確認改由呼叫端包 transaction\n謝謝'), [
    { kind: 'ack', shortId: 'F1', idPrefix: '3fa2', sha: 'a1b2c3d', reason: '已確認改由呼叫端包 transaction' },
  ]);
  assert.deepEqual(parseCommands('/REVIEWER ACK f01-3FA2@A1B2C3D'), [{ kind: 'ack', shortId: 'F1', idPrefix: '3fa2', sha: 'a1b2c3d', reason: '' }]);
  assert.deepEqual(parseCommands('/reviewer ack F1@a1b2c3d 沒有 id 前綴\n/reviewer help\n/reviewer'), [
    { kind: 'invalid', line: '/reviewer ack F1@a1b2c3d 沒有 id 前綴' },
    { kind: 'invalid', line: '/reviewer help' },
    { kind: 'invalid', line: '/reviewer' },
  ]);
  assert.deepEqual(parseCommands('/reviewers ack F1-3fa2@a1b2c3d x\n請 `/reviewer ack F1-3fa2@a1b2c3d x`'), []);
  assert.deepEqual(parseCommands(null), []);
});

test('parseCommands：全形符號（中文輸入法）視為半形', () => {
  assert.deepEqual(parseCommands('／ｒｅｖｉｅｗｅｒ　ａｃｋ　Ｆ１－３ｆａ２＠ａ１ｂ２ｃ３ｄ　理由，已確認'), [
    { kind: 'ack', shortId: 'F1', idPrefix: '3fa2', sha: 'a1b2c3d', reason: '理由,已確認' },
  ]);
});

test('parseCommands：引用、程式碼區塊與縮排程式碼中的指令不算', () => {
  const body = [
    '> /reviewer ack F1-3fa2@a1b2c3d 引用別人的確認',
    '  > /reviewer ack F2-3fa2@a1b2c3d 縮排的引用',
    '```',
    '/reviewer ack F3-3fa2@a1b2c3d 程式碼區塊',
    '~~~',
    '/reviewer ack F4-3fa2@a1b2c3d 仍在 ``` 區塊中（~~~ 不會關閉）',
    '```',
    '~~~~',
    '/reviewer ack F5-3fa2@a1b2c3d 波浪號區塊',
    '~~~~',
    '    /reviewer ack F6-3fa2@a1b2c3d 縮排程式碼',
    '\t/reviewer ack F7-3fa2@a1b2c3d tab 縮排',
    '   /reviewer ack F8-3fa2@a1b2c3d 三個空白以內仍然算',
  ].join('\n');
  assert.deepEqual(parseCommands(body).map(({ shortId }) => shortId), ['F8']);
});

test('parseCommands：單一留言最多處理 20 個指令', () => {
  assert.equal(parseCommands(Array.from({ length: 30 }, () => '/reviewer ack F1-3fa2@a1b2c3d x').join('\n')).length, 20);
});

test('isBotComment 與 permissionOf', () => {
  assert.equal(isBotComment({ user: { login: 'reviewer-bot[bot]', type: 'Bot' } }), true);
  assert.equal(isBotComment({ user: { login: 'github-actions[bot]' } }), true);
  assert.equal(isBotComment({ user: { login: 'alice', type: 'User' } }), false);
  assert.equal(isBotComment({}), false);

  assert.equal(permissionOf({ Alice: 'write' }, 'alice'), 'write');
  assert.equal(permissionOf({ bob: { role_name: 'maintain', permission: 'write' } }, 'bob'), 'maintain');
  assert.equal(permissionOf({ bob: { permission: 'admin' } }, 'bob'), 'admin');
  assert.equal(permissionOf({ bob: 'owner' }, 'bob'), null);
  assert.equal(permissionOf({}, 'bob'), null);
  assert.equal(permissionOf(null, 'bob'), null);
});

/**
 * 驗證情境：F1（ITEM）與 F9（OTHER，同前綴 3fa）；head SHA 時兩者的 fingerprint。
 */
const context = (overrides = {}) => ({
  pr: { login: 'author' },
  permissions: { alice: 'write', reader: 'read' },
  minPermission: 'write',
  known: new Map([[ITEM, { shortId: 'F1' }], [OTHER, { shortId: 'F9' }], ['dead'.padEnd(64, '0'), { shortId: 'F5' }]]),
  current: new Map([[ITEM, { scope: 's1', policy: 'p1' }], [OTHER, { scope: 's9', policy: 'p9' }]]),
  heads: new Map([[SHA, new Map([[ITEM, { scope: 's1', policy: 'p1' }]])], ['a1b2c3d9'.padEnd(40, '0'), new Map()]]),
  checkShortId: true,
  ...overrides,
});
const comment = (overrides = {}) => ({ id: 1, user: { login: 'alice' }, created_at: 't1', updated_at: 't1', ...overrides });
const ack = (overrides = {}) => ({ kind: 'ack', shortId: 'F1', idPrefix: '3fa2', sha: 'a1b2c3d4', reason: '看過了', ...overrides });
const code = (command = ack(), from = comment(), ctx = context()) => evaluateAck(command, from, ctx).code;

test('evaluateAck：通過時回傳項目與完整的 head', () => {
  assert.deepEqual(evaluateAck(ack(), comment(), context()), { accepted: true, code: 'ACK_ACCEPTED', itemId: ITEM, sha: SHA });
  // 權限比較大小寫不分；admin 高於 write；沒有 updated_at 也可以。
  assert.equal(code(ack(), comment({ user: { login: 'ALICE' }, updated_at: undefined })), 'ACK_ACCEPTED');
  assert.equal(code(ack(), comment(), context({ permissions: { alice: 'admin' }, minPermission: 'maintain' })), 'ACK_ACCEPTED');
  // 重播（狀態遺失）時短編號重新配發，不檢查。
  assert.equal(code(ack({ shortId: 'F7' }), comment(), context({ checkShortId: false })), 'ACK_ACCEPTED');
});

test('evaluateAck：依序拒絕各種不合法的確認', () => {
  assert.equal(code(ack(), comment({ updated_at: 't2' })), 'ACK_EDITED');
  assert.equal(code(ack(), comment({ user: { login: 'Author' } })), 'ACK_BY_AUTHOR');
  assert.equal(code(ack(), comment({ user: {} })), 'ACK_BY_AUTHOR');
  assert.equal(code(ack(), comment({ user: { login: 'stranger' } })), 'ACK_PERMISSION_UNKNOWN');
  assert.equal(code(ack(), comment({ user: { login: 'reader' } })), 'ACK_PERMISSION_DENIED');
  assert.equal(code(ack(), comment(), context({ minPermission: 'admin' })), 'ACK_PERMISSION_DENIED');
  assert.equal(code(ack({ reason: '' })), 'ACK_REASON_MISSING');
  assert.equal(code(ack({ idPrefix: '3fa' })), 'ACK_ID_AMBIGUOUS');
  assert.equal(code(ack({ idPrefix: 'beef' })), 'ACK_ITEM_UNKNOWN');
  assert.equal(code(ack({ shortId: 'F2' })), 'ACK_SHORT_ID_MISMATCH');
  assert.equal(code(ack({ shortId: 'F5', idPrefix: 'dead' })), 'ACK_ITEM_FIXED');
  assert.equal(code(ack({ sha: 'a1b2c3d' })), 'ACK_SHA_AMBIGUOUS');
  assert.equal(code(ack({ sha: 'ffffffff' })), 'ACK_SHA_UNKNOWN');
  assert.equal(code(ack({ shortId: 'F9', idPrefix: '3fa9' })), 'ACK_ITEM_NOT_AT_SHA');
  assert.equal(code(ack(), comment(), context({ current: new Map([[ITEM, { scope: 's2', policy: 'p1' }]]) })), 'ACK_CODE_CHANGED');
  assert.equal(code(ack(), comment(), context({ current: new Map([[ITEM, { scope: 's1', policy: 'p2' }]]) })), 'ACK_POLICY_CHANGED');
});

test('ackMessage：每個代碼都有說明', () => {
  const codes = ['ACK_ACCEPTED', 'ACK_FORMAT_INVALID', 'ACK_EDITED', 'ACK_BY_AUTHOR', 'ACK_PERMISSION_UNKNOWN', 'ACK_PERMISSION_DENIED',
    'ACK_REASON_MISSING', 'ACK_ID_AMBIGUOUS', 'ACK_ITEM_UNKNOWN', 'ACK_SHORT_ID_MISMATCH', 'ACK_ITEM_FIXED', 'ACK_SHA_AMBIGUOUS',
    'ACK_SHA_UNKNOWN', 'ACK_ITEM_NOT_AT_SHA', 'ACK_CODE_CHANGED', 'ACK_POLICY_CHANGED'];
  const messages = codes.map((value) => ackMessage(value, { label: 'F1-3fa2', sha: SHA, minPermission: 'maintain' }));
  assert.equal(new Set(messages).size, codes.length - 1, 'SHA_AMBIGUOUS 與 SHA_UNKNOWN 共用說明');
  assert.match(messages[0], /^✅ 已確認 F1-3fa2（head `a1b2c3d`）/);
  assert.ok(messages[1].includes(ACK_USAGE));
  assert.match(messages[5], /maintain/);
  assert.match(ackMessage('SOMETHING_ELSE'), /SOMETHING_ELSE/);
  assert.match(ackMessage('ACK_PERMISSION_DENIED'), /write/);
});
