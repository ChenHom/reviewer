import test from 'node:test';
import assert from 'node:assert/strict';

import { createConfigRulesInterpreter } from '../../src/interpreters/config-rules.js';

const callee = (name, receiver = null, kind = 'method') => ({ text: name, name, receiver, kind, optional: false });
const rules = (overrides) => ({
  sensitiveOperands: [],
  protectedCalls: [],
  protectedArguments: [],
  sideEffectCalls: [],
  ...overrides,
});
const run = (interpreter, kind, properties) => {
  const result = interpreter.interpret({ id: 'f-1', kind, subject: 'A::b', properties });
  return result.handled ? result.blockers : null;
};

test('sensitiveOperands：符合 pattern 且運算子屬於指定類別時為 SENSITIVE_OPERAND_CHANGED', () => {
  const interpreter = createConfigRulesInterpreter(rules({
    sensitiveOperands: [{ pattern: '/balance|amount/i', operators: 'arithmetic' }, { pattern: '/stock/' }],
  }), 'a'.repeat(64));
  const operator = (before, after, expression) => run(interpreter, 'BINARY_OPERATOR_CHANGED', {
    operatorBefore: before, operatorAfter: after, before: expression, after: expression,
  });
  assert.deepEqual(operator('-', '+', '$cash->amount - $x'), ['SENSITIVE_OPERAND_CHANGED']);
  assert.equal(operator('<', '<=', '$cash->amount < $x'), null, '運算子類別不符');
  assert.equal(operator('-', '+', '$count - 1'), null, 'pattern 不符');
  assert.deepEqual(operator('<', '<=', '$stock < 1'), ['SENSITIVE_OPERAND_CHANGED'], 'operators 預設為 any');
  assert.equal(interpreter.id, 'config-rules');
  assert.equal(interpreter.version, `1.1.0+${'a'.repeat(16)}`);
});

test('protectedCalls / sideEffectCalls 比對 name 與 receiver（最後一段或以 . 連接的完整路徑）', () => {
  const interpreter = createConfigRulesInterpreter(rules({
    protectedCalls: [{ name: 'reserveStock' }, { receiver: 'Illuminate.Support.Facades.Gate', name: 'authorize' }],
    sideEffectCalls: [{ receiver: 'Mail' }, { name: '/^notify/' }],
  }), 'b'.repeat(64));

  assert.deepEqual(run(interpreter, 'CALL_REMOVED', { callee: callee('reserveStock', ['this', 'inventory']) }), ['PROTECTED_CALL_REMOVED']);
  assert.deepEqual(
    run(interpreter, 'CALL_REMOVED', { callee: callee('authorize', ['Illuminate', 'Support', 'Facades', 'Gate'], 'static') }),
    ['PROTECTED_CALL_REMOVED'],
  );
  assert.equal(run(interpreter, 'CALL_REMOVED', { callee: callee('authorize', ['Gate'], 'static') }), null, '完整路徑不符');
  assert.equal(run(interpreter, 'CALL_ADDED', { callee: callee('reserveStock') }), null, 'protectedCalls 只看移除');

  assert.deepEqual(run(interpreter, 'CALL_ADDED', { callee: callee('to', ['Mail'], 'static') }), ['SIDE_EFFECT_CALL_ADDED']);
  assert.deepEqual(run(interpreter, 'CALL_ADDED', { callee: callee('notifyNow', ['user']) }), ['SIDE_EFFECT_CALL_ADDED']);
  assert.equal(run(interpreter, 'CALL_ADDED', { callee: callee('send') }), null, '鏈式 call 沒有 receiver');
  assert.equal(run(interpreter, 'CALL_REMOVED', { callee: callee('to', ['Mail'], 'static') }), null, 'sideEffectCalls 只看新增');
  assert.equal(run(interpreter, 'CALL_REMOVED', { callee: 'legacy string' }), null);
});

test('protectedArguments 比對具名參數或位置，可指定 blocker', () => {
  const interpreter = createConfigRulesInterpreter(rules({
    protectedArguments: [
      { argument: 'idempotencyKey', blocker: 'PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED' },
      { argument: 1, name: 'charge' },
    ],
  }), 'c'.repeat(64));
  const argument = (kind, name, value) => run(interpreter, kind, { callee: callee(name, ['gateway']), argument: value });
  assert.deepEqual(argument('CALL_ARGUMENT_CHANGED', 'charge', 'idempotencyKey'), ['PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED']);
  assert.deepEqual(argument('CALL_ARGUMENT_ADDED', 'refund', 'idempotencyKey'), ['PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED']);
  assert.deepEqual(argument('CALL_ARGUMENT_REMOVED', 'charge', 1), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.equal(argument('CALL_ARGUMENT_REMOVED', 'refund', 1), null);
  assert.equal(argument('CALL_ARGUMENT_CHANGED', 'charge', 0), null);
  assert.equal(argument('CALL_ARGUMENT_CHANGED', 'charge', '1'), null, '具名參數名稱不等於位置');
});

test('protectedArguments 也比對參數內的值變更（container 為該參數）與位置參數的順序改變', () => {
  const interpreter = createConfigRulesInterpreter(rules({
    sensitiveOperands: [{ pattern: '/amount/', operators: 'arithmetic' }],
    protectedArguments: [{ argument: 0, name: 'charge' }, { argument: 'idempotencyKey' }],
  }), 'e'.repeat(64));
  const container = (name, argument, keys = []) => ({ type: 'argument', callee: callee(name, ['gateway']), argument, keys, text: `${name}#${argument}` });

  // `charge(100)` → `charge(1000)`：analyzer 以 LITERAL_CHANGED 解釋，不會產生 CALL_ARGUMENT_CHANGED。
  assert.deepEqual(run(interpreter, 'LITERAL_CHANGED', { container: container('charge', 0), before: '100', after: '1000' }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'VARIABLE_CHANGED', { container: container('charge', 0), before: 'a', after: 'b' }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'ARRAY_ITEM_REMOVED', { container: container('charge', 0, ['options']), key: 'lock', value: 'true' }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'LITERAL_CHANGED', { container: container('pay', 'idempotencyKey'), before: "'a'", after: "'b'" }), ['PROTECTED_ARGUMENT_CHANGED']);
  // 運算子改變同時可能是敏感運算元與受保護的參數。
  assert.deepEqual(run(interpreter, 'BINARY_OPERATOR_CHANGED', {
    container: container('charge', 0), operatorBefore: '-', operatorAfter: '+', before: 'amount - fee', after: 'amount + fee',
  }), ['SENSITIVE_OPERAND_CHANGED', 'PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'CALL_ARGUMENTS_REORDERED', { callee: callee('charge', ['gateway']), before: 'a, b', after: 'b, a' }), ['PROTECTED_ARGUMENT_CHANGED']);

  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: container('charge', 1), before: '1', after: '2' }), null);
  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: container('refund', 0), before: '1', after: '2' }), null);
  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: { type: 'const', name: 'charge', keys: [], text: 'const:charge' }, before: '1', after: '2' }), null);
  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: { type: 'argument', callee: null, argument: 0, keys: [], text: 'call#0' }, before: '1', after: '2' }), null);
  assert.equal(run(interpreter, 'CALL_ARGUMENTS_REORDERED', { callee: callee('pay', ['gateway']), before: 'a, b', after: 'b, a' }), null, '具名參數不受順序影響');
  assert.equal(run(interpreter, 'BINARY_OPERATOR_CHANGED', { container: container('refund', 0), operatorBefore: '<', operatorAfter: '<=', before: 'x < 1', after: 'x <= 1' }), null);
});

test('沒有規則命中的 fact 交給其他 interpreter（handled: false）', () => {
  const interpreter = createConfigRulesInterpreter(rules({ protectedCalls: [{ name: 'x' }] }), 'd'.repeat(64));
  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: { type: 'return', keys: [], text: 'return' } }), null);
  assert.equal(run(interpreter, 'BINARY_OPERATOR_CHANGED', { operatorBefore: '<', operatorAfter: '<=' }), null);
  assert.equal(interpreter.interpret(undefined).handled, false);
});
