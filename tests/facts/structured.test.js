import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayArgument,
  displayText,
  receiverIs,
  receiverLast,
  structuredCallee,
  structuredContainer,
} from '../../src/facts/structured.js';

const callee = { text: '$this->adminDB->transaction', name: 'transaction', receiver: ['this', 'adminDB'], kind: 'method', optional: false };

test('structuredCallee 只接受形狀完整的 callee', () => {
  assert.equal(structuredCallee(callee), callee);
  assert.equal(structuredCallee({ ...callee, receiver: null }).receiver, null);
  for (const invalid of [
    undefined,
    '$this->adminDB->transaction',
    { ...callee, name: '' },
    { ...callee, kind: 'call' },
    { ...callee, optional: 'no' },
    { ...callee, receiver: 'this' },
    { ...callee, receiver: ['this', 1] },
    { ...callee, text: undefined },
  ]) {
    assert.equal(structuredCallee(invalid), null, JSON.stringify(invalid));
  }
});

test('structuredContainer 只接受有 type / keys / text 的 container', () => {
  const container = { type: 'property', name: 'fillable', keys: [], text: 'property:$fillable' };
  assert.equal(structuredContainer(container), container);
  for (const invalid of [null, 'property:$fillable', { ...container, keys: 'a' }, { ...container, keys: [1] }, { ...container, type: 1 }, { ...container, text: null }]) {
    assert.equal(structuredContainer(invalid), null, JSON.stringify(invalid));
  }
});

test('receiver helpers 比對最後一段或完整路徑', () => {
  assert.equal(receiverLast(callee), 'adminDB');
  assert.equal(receiverLast({ ...callee, receiver: null }), '');
  assert.equal(receiverLast(null), '');
  const gate = { ...callee, receiver: ['Illuminate', 'Support', 'Facades', 'Gate'] };
  assert.equal(receiverIs(gate, ['Gate', 'Illuminate\\Support\\Facades\\Gate']), true);
  assert.equal(receiverIs(gate, ['Gate']), false);
  assert.equal(receiverIs({ ...callee, receiver: null }, ['']), false);
});

test('display helpers 輸出顯示文字', () => {
  assert.equal(displayText(callee), '$this->adminDB->transaction');
  assert.equal(displayText('legacy'), 'legacy');
  assert.equal(displayText(undefined), '');
  assert.equal(displayText({ foo: 1 }), '{"foo":1}');
  assert.equal(displayText('<='), '<=');
  assert.equal(displayArgument(0), '#0');
  assert.equal(displayArgument('idempotencyKey'), 'idempotencyKey');
  assert.equal(displayArgument(undefined), '');
});
