import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARGUMENT_ORDER_INTERPRETER,
  AUTHORIZATION_GUARD_INTERPRETER,
  CONSTANT_VALUE_INTERPRETER,
  GUARD_CLAUSE_INTERPRETER,
  LARAVEL_MODEL_ATTRIBUTES_INTERPRETER,
  LARAVEL_VALIDATION_INTERPRETER,
  NEGATION_INTERPRETER,
  RETURN_VALUE_INTERPRETER,
  VARIABLE_CHANGE_INTERPRETER,
  OPERATOR_CHANGE_INTERPRETER,
  MIDDLEWARE_GUARD_INTERPRETER,
  PAYMENT_IDEMPOTENCY_INTERPRETER,
  PHP_LARAVEL_DOMAIN_INTERPRETERS,
  ROW_LOCK_INTERPRETER,
  SIGNATURE_VERIFICATION_INTERPRETER,
  TRANSACTION_BOUNDARY_INTERPRETER,
  calleeParts,
} from '../../src/interpreters/php-laravel-domain.js';
import { validateFactInterpreters } from '../../src/facts/interpreter.js';

function removed(callee) {
  return { id: 'php-1', kind: 'CALL_REMOVED', properties: { callee, changeSide: 'before' } };
}

function argumentChanged(callee, argument, before, after) {
  return {
    id: 'php-2',
    kind: 'CALL_ARGUMENT_CHANGED',
    properties: { callee, argument, before, after, changeSide: 'after' },
  };
}

function blockersOf(interpreter, fact) {
  const result = interpreter.interpret(fact);
  return result.handled ? result.blockers : null;
}

test('calleeParts 移除 fully-qualified 前導反斜線並拆出 receiver/method', () => {
  assert.deepEqual(calleeParts('\\DB::transaction'), {
    receiver: 'DB',
    method: 'transaction',
    normalized: 'DB::transaction',
  });
  assert.deepEqual(calleeParts('$this->adminDB->transaction'), {
    receiver: '$this->adminDB',
    method: 'transaction',
    normalized: '$this->adminDB->transaction',
  });
  assert.deepEqual(calleeParts('->lockForUpdate'), {
    receiver: '',
    method: 'lockForUpdate',
    normalized: '->lockForUpdate',
  });
  assert.deepEqual(calleeParts('$user?->can'), {
    receiver: '$user',
    method: 'can',
    normalized: '$user?->can',
  });
  assert.deepEqual(calleeParts('helper'), { receiver: '', method: 'helper', normalized: 'helper' });
  assert.equal(calleeParts(undefined), null);
  assert.equal(calleeParts(''), null);
});

test('interpreter set 保持合法且 id 唯一', () => {
  assert.deepEqual(validateFactInterpreters(PHP_LARAVEL_DOMAIN_INTERPRETERS), {
    valid: true,
    errors: [],
  });
  const ids = PHP_LARAVEL_DOMAIN_INTERPRETERS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
});

test('transaction interpreter 辨識 FQ facade、connection 與 begin/commit/rollBack', () => {
  for (const callee of [
    'DB::transaction',
    '\\DB::transaction',
    'Illuminate\\Support\\Facades\\DB::transaction',
    '$this->adminDB->transaction',
    '$db->transaction',
    '$connection->transaction',
    '\\DB::beginTransaction',
    '$pdo->beginTransaction',
    '$anything->beginTransaction',
    '\\DB::commit',
    '$db->commit',
  ]) {
    assert.deepEqual(
      blockersOf(TRANSACTION_BOUNDARY_INTERPRETER, removed(callee)),
      ['TRANSACTION_BOUNDARY_REMOVED'],
      callee,
    );
  }

  for (const callee of ['\\DB::rollBack', '$db->rollback', '$this->payDB->rollBack']) {
    assert.deepEqual(
      blockersOf(TRANSACTION_BOUNDARY_INTERPRETER, removed(callee)),
      ['TRANSACTION_ROLLBACK_REMOVED'],
      callee,
    );
  }
});

test('transaction interpreter 不誤判非 DB receiver 或非移除 fact', () => {
  for (const callee of ['$git->commit', '$order->transaction', '$repo->rollBack', 'Cache::commit']) {
    assert.equal(blockersOf(TRANSACTION_BOUNDARY_INTERPRETER, removed(callee)), null, callee);
  }
  assert.equal(
    blockersOf(TRANSACTION_BOUNDARY_INTERPRETER, {
      id: 'php-3',
      kind: 'CALL_ADDED',
      properties: { callee: 'DB::transaction' },
    }),
    null,
  );
  assert.equal(blockersOf(TRANSACTION_BOUNDARY_INTERPRETER, undefined), null);
});

test('authorization interpreter 接受 FQ Gate 並拒絕其他 callee', () => {
  for (const callee of [
    '$this->authorize',
    '$this->authorizeForUser',
    'Gate::authorize',
    '\\Gate::authorize',
    '\\Illuminate\\Support\\Facades\\Gate::authorize',
  ]) {
    assert.deepEqual(
      blockersOf(AUTHORIZATION_GUARD_INTERPRETER, removed(callee)),
      ['AUTHORIZATION_GUARD_REMOVED'],
      callee,
    );
  }
  assert.equal(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, removed('$model->authorize')), null);
});

test('middleware interpreter 處理 middleware call 移除', () => {
  for (const callee of ['$this->middleware', 'Route::middleware', '\\Route::middleware']) {
    assert.deepEqual(
      blockersOf(MIDDLEWARE_GUARD_INTERPRETER, removed(callee)),
      ['MIDDLEWARE_GUARD_REMOVED'],
      callee,
    );
  }
  assert.equal(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, removed('$this->authorize')), null);
  assert.equal(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, undefined), null);
});

test('middleware interpreter 只在 Route::group middleware 被移除時產生 blocker', () => {
  const group = (before, after) => argumentChanged('Route::group', '#0', before, after);

  assert.deepEqual(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, group(
      "['middleware' => ['auth:admin', 'loginBasic:admin']]",
      "['middleware' => ['loginBasic:admin']]",
    )),
    ['MIDDLEWARE_GUARD_REMOVED'],
  );
  assert.deepEqual(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, group(
      "['middleware' => 'check.permission:admin', 'prefix' => 'role']",
      "['prefix' => 'role']",
    )),
    ['MIDDLEWARE_GUARD_REMOVED'],
  );
  // 新增 middleware 或只改 prefix 不是 guard 移除。
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, group(
      "['middleware' => ['auth:admin']]",
      "['middleware' => ['auth:admin', 'throttle']]",
    )),
    null,
  );
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, group("['prefix' => 'role']", "['prefix' => 'roles']")),
    null,
  );
  // Route::group 的 closure 參數（#1）不由此 interpreter 判讀。
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, argumentChanged('Route::group', '#1', "'a'", "'b'")),
    null,
  );
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, argumentChanged('Route::get', '#0', "'/a'", "'/b'")),
    null,
  );
});

test('middleware interpreter 處理 ->middleware(...) 參數中的 middleware 移除', () => {
  assert.deepEqual(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, argumentChanged(
      '->middleware',
      '#0',
      "['auth', \"verified\"]",
      "['auth']",
    )),
    ['MIDDLEWARE_GUARD_REMOVED'],
  );
  // guard 換成另一個 guard 也保守視為原 middleware 被移除。
  assert.deepEqual(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, argumentChanged('->middleware', '#0', "'auth'", "'auth:api'")),
    ['MIDDLEWARE_GUARD_REMOVED'],
  );
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, argumentChanged('->middleware', '#0', "'auth'", "['auth', 'x']")),
    null,
  );
});

test('row lock interpreter 辨識 lockForUpdate/sharedLock 移除', () => {
  for (const callee of ['->lockForUpdate', '$query->lockForUpdate', 'CashFlow::sharedLock']) {
    assert.deepEqual(
      blockersOf(ROW_LOCK_INTERPRETER, removed(callee)),
      ['ROW_LOCK_REMOVED'],
      callee,
    );
  }
  assert.equal(blockersOf(ROW_LOCK_INTERPRETER, removed('->find')), null);
});

test('signature verification interpreter 辨識常見驗簽 method', () => {
  for (const callee of [
    '$payment->verificationSign',
    '$this->verifySign',
    'self::verifySign',
    '$gateway->checkSign',
    '$this->validateSignature',
    '$client->signatureVerify',
  ]) {
    assert.deepEqual(
      blockersOf(SIGNATURE_VERIFICATION_INTERPRETER, removed(callee)),
      ['SIGNATURE_VERIFICATION_REMOVED'],
      callee,
    );
  }
  for (const callee of ['$this->sign', '$payment->signIn', '$user->design']) {
    assert.equal(blockersOf(SIGNATURE_VERIFICATION_INTERPRETER, removed(callee)), null, callee);
  }
});

test('payment idempotency interpreter 不處理位置參數', () => {
  assert.equal(
    blockersOf(PAYMENT_IDEMPOTENCY_INTERPRETER, argumentChanged('$gateway->charge', '#0', '$a', '$b')),
    null,
  );
});

function arrayItemRemoved(container, value = "'auth'") {
  return {
    id: 'php-4',
    kind: 'ARRAY_ITEM_REMOVED',
    properties: { container, key: null, value, changeSide: 'before' },
  };
}

test('middleware interpreter 處理 middleware container 的 ARRAY_ITEM_REMOVED', () => {
  for (const container of [
    'Route::group#0[middleware]',
    'Route::group#0[prefix][middleware]',
    '->middleware#0',
    'Route::middleware#0',
    'property:$middleware',
    'property:$beforeActionList',
  ]) {
    assert.deepEqual(
      blockersOf(MIDDLEWARE_GUARD_INTERPRETER, arrayItemRemoved(container)),
      ['MIDDLEWARE_GUARD_REMOVED'],
      container,
    );
  }
  assert.deepEqual(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, {
      id: 'php-8',
      kind: 'ARRAY_ITEM_REMOVED',
      properties: {
        container: 'Route::group#0',
        key: "'middleware'",
        value: "'check.permission:admin'",
        changeSide: 'before',
      },
    }),
    ['MIDDLEWARE_GUARD_REMOVED'],
  );
  for (const container of ['Route::group#0', 'property:$fillable', 'assign:$middleware', '->where#0', 'file']) {
    assert.equal(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, arrayItemRemoved(container)), null, container);
  }
  assert.equal(
    blockersOf(MIDDLEWARE_GUARD_INTERPRETER, {
      id: 'php-5',
      kind: 'ARRAY_ITEM_ADDED',
      properties: { container: 'property:$middleware', key: null, value: "'x'", changeSide: 'after' },
    }),
    null,
  );
});

test('operator interpreter 依運算子類別回傳 blocker', () => {
  const operatorChanged = (before, after) => ({
    id: 'php-6',
    kind: 'BINARY_OPERATOR_CHANGED',
    properties: { operatorBefore: before, operatorAfter: after, before: 'a', after: 'b', changeSide: 'after' },
  });

  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('<', '<=')), ['COMPARISON_OPERATOR_CHANGED']);
  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('===', '==')), ['COMPARISON_OPERATOR_CHANGED']);
  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('-', '+')), ['ARITHMETIC_OPERATOR_CHANGED']);
  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('&&', '||')), ['LOGICAL_OPERATOR_CHANGED']);
  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('.', '+')), ['OPERATOR_CHANGED']);
  assert.deepEqual(blockersOf(OPERATOR_CHANGE_INTERPRETER, operatorChanged('<', '+')), ['OPERATOR_CHANGED']);
  assert.equal(
    blockersOf(OPERATOR_CHANGE_INTERPRETER, { id: 'x', kind: 'BINARY_OPERATOR_CHANGED', properties: {} }),
    null,
  );
  assert.equal(blockersOf(OPERATOR_CHANGE_INTERPRETER, removed('$a->b')), null);
});

test('guard clause interpreter 處理 guard 的移除與新增', () => {
  const guard = (kind) => ({
    id: 'php-7',
    kind,
    properties: { condition: '!$ok', exit: 'throw', changeSide: kind === 'GUARD_REMOVED' ? 'before' : 'after' },
  });

  assert.deepEqual(blockersOf(GUARD_CLAUSE_INTERPRETER, guard('GUARD_REMOVED')), ['GUARD_CLAUSE_REMOVED']);
  assert.deepEqual(blockersOf(GUARD_CLAUSE_INTERPRETER, guard('GUARD_ADDED')), ['GUARD_CLAUSE_ADDED']);
  assert.equal(blockersOf(GUARD_CLAUSE_INTERPRETER, removed('$a->b')), null);
});

function valueFact(kind, properties, subject = 'Service::run') {
  return { id: 'php-8', kind, subject, properties: { changeSide: 'after', ...properties } };
}

test('literal 變更：middleware 名稱被換掉、authorize ability 改變、class 常數改值', () => {
  const literal = (container, before, after) => valueFact('LITERAL_CHANGED', { container, before, after });

  assert.deepEqual(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, literal('$this->middleware#0', "'auth'", "'guest'")), ['MIDDLEWARE_GUARD_REMOVED']);
  assert.deepEqual(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, literal('Route::group#0[middleware]', "'auth'", "'authX'")), ['MIDDLEWARE_GUARD_REMOVED']);
  // 不是 middleware container，或新值仍包含原本的名稱（只剩引號差異不會產生 fact）
  assert.equal(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, literal('$q->take#0', "'auth'", "'guest'")), null);
  assert.equal(blockersOf(MIDDLEWARE_GUARD_INTERPRETER, literal('->middleware#0', '1', '2')), null);

  assert.deepEqual(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, literal('$this->authorize#0', "'update'", "'view'")), ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.deepEqual(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, literal('\\Gate::authorize#0', "'update'", "'view'")), ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.equal(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, literal('$this->authorize#1', '1', '2')), null);
  assert.equal(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, literal('$q->take#0', '1', '2')), null);
  assert.equal(blockersOf(AUTHORIZATION_GUARD_INTERPRETER, valueFact('LITERAL_CHANGED', {})), null);

  assert.deepEqual(blockersOf(CONSTANT_VALUE_INTERPRETER, literal('const:RATE', '3', '30')), ['CONSTANT_VALUE_CHANGED']);
  assert.equal(blockersOf(CONSTANT_VALUE_INTERPRETER, literal('return', '3', '30')), null);
  assert.equal(blockersOf(CONSTANT_VALUE_INTERPRETER, removed('$a->b')), null);
});

test('negation、回傳值、參數順序與變數變更各自對應 blocker', () => {
  const negated = (container) => valueFact('EXPRESSION_NEGATED', { container, before: '$a', after: '!$a' });
  for (const container of ['if', 'while', 'for', 'ternary', 'match', 'match-arm']) {
    assert.deepEqual(blockersOf(NEGATION_INTERPRETER, negated(container)), ['CONDITION_NEGATED'], container);
  }
  assert.deepEqual(blockersOf(NEGATION_INTERPRETER, negated('return')), ['BOOLEAN_VALUE_NEGATED']);
  assert.equal(blockersOf(NEGATION_INTERPRETER, removed('$a->b')), null);

  assert.deepEqual(blockersOf(RETURN_VALUE_INTERPRETER, valueFact('RETURN_VALUE_CHANGED', { before: '$a', after: 'null' })), ['RETURN_VALUE_CHANGED']);
  assert.equal(blockersOf(RETURN_VALUE_INTERPRETER, removed('$a->b')), null);

  assert.deepEqual(
    blockersOf(ARGUMENT_ORDER_INTERPRETER, valueFact('CALL_ARGUMENTS_REORDERED', { callee: 'max', before: '$a, $b', after: '$b, $a' })),
    ['ARGUMENTS_REORDERED'],
  );
  assert.equal(blockersOf(ARGUMENT_ORDER_INTERPRETER, removed('$a->b')), null);

  const variable = (container) => valueFact('VARIABLE_CHANGED', { container, before: '$a', after: '$b' });
  assert.deepEqual(blockersOf(VARIABLE_CHANGE_INTERPRETER, variable('param')), ['PARAMETER_RENAMED']);
  assert.deepEqual(blockersOf(VARIABLE_CHANGE_INTERPRETER, variable('return')), ['VARIABLE_REFERENCE_CHANGED']);
  assert.equal(blockersOf(VARIABLE_CHANGE_INTERPRETER, removed('$a->b')), null);
});

test('Laravel validation rules：rules() 回傳值、$request->validate、Validator::make', () => {
  const blockers = (fact) => blockersOf(LARAVEL_VALIDATION_INTERPRETER, fact);

  assert.deepEqual(blockers(valueFact('LITERAL_CHANGED', { container: 'return[title]', before: "'max:255'", after: "'max:256'" }, 'TaskRequest::rules')), ['VALIDATION_RULE_CHANGED']);
  assert.deepEqual(blockers(valueFact('ARRAY_ITEM_REMOVED', { container: 'return[email]', key: null, value: "'required'" }, 'LoginRequest::rules')), ['VALIDATION_RULE_CHANGED']);
  assert.deepEqual(blockers(valueFact('RETURN_VALUE_CHANGED', { before: '[...]', after: '[]' }, 'TaskRequest::rules')), ['VALIDATION_RULE_CHANGED']);
  assert.deepEqual(blockers(valueFact('ARRAY_ITEM_ADDED', { container: '$request->validate#0[name]', key: null, value: "'nullable'" })), ['VALIDATION_RULE_CHANGED']);
  assert.deepEqual(blockers(valueFact('LITERAL_CHANGED', { container: '$this->validateWithBag#1[password]', before: "'min:8'", after: "'min:6'" })), ['VALIDATION_RULE_CHANGED']);
  assert.deepEqual(blockers(valueFact('LITERAL_CHANGED', { container: '\\Illuminate\\Support\\Facades\\Validator::make#1[amount]', before: "'integer'", after: "'numeric'" })), ['VALIDATION_RULE_CHANGED']);

  // 帳密驗證（Auth::guard()->validate）、rules() 以外的 method、rules() 中 return 以外的位置、非值變更的 fact
  assert.equal(blockers(valueFact('LITERAL_CHANGED', { container: '->validate#0[email]', before: "'a'", after: "'b'" })), null);
  assert.equal(blockers(valueFact('LITERAL_CHANGED', { container: 'return[title]', before: '1', after: '2' }, 'TaskRequest::messages')), null);
  assert.equal(blockers(valueFact('LITERAL_CHANGED', { container: 'assign:$rules', before: '1', after: '2' }, 'TaskRequest::rules')), null);
  assert.equal(blockers(valueFact('LITERAL_CHANGED', { container: 'Validator::make#0', before: '1', after: '2' })), null);
  assert.equal(blockers(removed('$request->validate')), null);
});

test('Laravel model attributes：fillable / guarded / hidden / casts', () => {
  const blockers = (fact) => blockersOf(LARAVEL_MODEL_ATTRIBUTES_INTERPRETER, fact);
  const item = (kind, container, subject) => valueFact(kind, { container, key: null, value: "'role'" }, subject);

  assert.deepEqual(blockers(item('ARRAY_ITEM_ADDED', 'property:$fillable')), ['MASS_ASSIGNMENT_CHANGED']);
  assert.deepEqual(blockers(item('ARRAY_ITEM_REMOVED', 'property:$guarded')), ['MASS_ASSIGNMENT_CHANGED']);
  assert.deepEqual(blockers(item('ARRAY_ITEM_REMOVED', 'property:$hidden')), ['SERIALIZED_ATTRIBUTES_CHANGED']);
  assert.deepEqual(blockers(item('ARRAY_ITEM_ADDED', 'property:$visible')), ['SERIALIZED_ATTRIBUTES_CHANGED']);
  assert.deepEqual(blockers(valueFact('LITERAL_CHANGED', { container: 'property:$casts', before: "'datetime'", after: "'date'" })), ['ATTRIBUTE_CAST_CHANGED']);
  assert.deepEqual(blockers(item('LITERAL_CHANGED', 'return[password]', 'User::casts')), ['ATTRIBUTE_CAST_CHANGED']);

  assert.equal(blockers(item('ARRAY_ITEM_ADDED', 'property:$appends')), null);
  assert.equal(blockers(item('ARRAY_ITEM_ADDED', 'property:constructor')), null);
  assert.equal(blockers(item('ARRAY_ITEM_ADDED', 'return', 'User::toArray')), null);
  assert.equal(blockers(removed('$a->b')), null);
});
