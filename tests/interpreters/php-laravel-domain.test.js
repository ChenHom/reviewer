import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORIZATION_GUARD_INTERPRETER,
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
