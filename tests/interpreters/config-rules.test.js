import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../analyzers/ts/src/analyze.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';
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
  assert.equal(interpreter.version, `1.2.0+${'a'.repeat(16)}`);
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
  // 參數中的巢狀呼叫被替換或參數增減：call / 參數 fact 帶有外層參數的 container。
  assert.deepEqual(run(interpreter, 'CALL_REMOVED', { callee: callee('calculateFee', null, 'function'), container: container('charge', 0) }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'CALL_ARGUMENT_REMOVED', { callee: callee('fee', null, 'function'), container: container('charge', 0), argument: 1 }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(run(interpreter, 'CALL_ARGUMENT_CHANGED', { callee: callee('charge', ['gateway']), container: container('charge', 0), argument: 0 }), ['PROTECTED_ARGUMENT_CHANGED']);

  assert.deepEqual(run(interpreter, 'LITERAL_CHANGED', { container: { ...container('fee', 0), outer: container('charge', 0) }, before: '1', after: '2' }), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.equal(run(interpreter, 'LITERAL_CHANGED', { container: { ...container('fee', 0), outer: container('charge', 1) }, before: '1', after: '2' }), null);
  assert.equal(run(interpreter, 'CALL_REMOVED', { callee: callee('calculateFee', null, 'function'), container: container('charge', 1) }), null);
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

test('protectedArguments：analyzer 產生的巢狀呼叫 fact 帶有外層參數（TS 與 PHP）', async () => {
  const interpreter = createConfigRulesInterpreter(rules({ protectedArguments: [{ argument: 0, name: 'charge' }] }), 'f'.repeat(64));
  const blockers = (facts) => [...new Set(facts.flatMap((fact) => {
    const result = interpreter.interpret(fact);
    return result.handled ? result.blockers : [];
  }))];

  const ts = (before, after) => {
    const fn = (body) => `export async function f(g: any, q: any) {\n  ${body}\n}\n`;
    const result = analyze({ path: 'a.ts', beforeSource: fn(before), afterSource: fn(after) });
    assert.equal(result.ok, true, result.code);
    return blockers(result.facts);
  };
  assert.deepEqual(ts('return g.charge(calculateFee());', 'return g.charge(calculateTotal());'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(ts('return g.charge(q.fee().round());', 'return g.charge(q.round());'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(ts('return g.charge(fee(a, b));', 'return g.charge(fee(a));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(ts('return g.charge(fee(a, b));', 'return g.charge(fee(b, a));'), ['PROTECTED_ARGUMENT_CHANGED']);
  // 更深的巢狀：值變更屬於最近的參數 `fee#0`，經由 `outer` 也屬於 `charge#0`。
  assert.deepEqual(ts('return g.charge(fee(a + 1));', 'return g.charge(fee(a + 2));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(ts('return g.charge({ amount: round(total(a)) });', 'return g.charge({ amount: round(subtotal(a)) });'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(ts('return g.charge(fee(), log());', 'return g.charge(fee(), audit());'), []);
  assert.deepEqual(ts('return g.charge(fee(), log(a + 1));', 'return g.charge(fee(), log(a + 2));'), []);
  assert.deepEqual(ts('return calculateFee();', 'return calculateTotal();'), []);

  const adapter = createPhpLaravelAdapter();
  const identity = { repository: 'example/php-app', baseSha: 'base', headSha: 'head', policyId: 'policy', policyVersion: '1', runnerVersion: '1' };
  const php = async (before, after) => {
    const wrap = (body) => `<?php\n\nclass S\n{\n    public function run($g, $q, $a, $b)\n    {\n        ${body}\n    }\n}\n`;
    const result = await adapter.analyze({ identity, path: 'app/S.php', beforeSource: wrap(before), afterSource: wrap(after) });
    return blockers(result.facts);
  };
  assert.deepEqual(await php('return $g->charge($this->calculateFee());', 'return $g->charge($this->calculateTotal());'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge(Fee::calc($q));', 'return $g->charge(Fee::total($q));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge($q->fee()->round());', 'return $g->charge($q->round());'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge($q->fee($a, $b));', 'return $g->charge($q->fee($a));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge($q->fee($a, $b));', 'return $g->charge($q->fee($b, $a));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge($q->fee($a + 1));', 'return $g->charge($q->fee($a + 2));'), ['PROTECTED_ARGUMENT_CHANGED']);
  assert.deepEqual(await php('return $g->charge($q->fee(), $q->log());', 'return $g->charge($q->fee(), $q->audit());'), []);
  assert.deepEqual(await php('return $g->charge($q->fee(), $q->log($a + 1));', 'return $g->charge($q->fee(), $q->log($a + 2));'), []);
});
