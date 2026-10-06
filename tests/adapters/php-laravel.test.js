import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createAnalysisContextBinding,
  validateAdapterResult,
} from '../../src/adapters/contracts.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';
import { createAuthorityState } from '../../src/publication.js';
import { runAdapterPipeline } from '../../src/runner.js';

const adapter = createPhpLaravelAdapter();
const identity = {
  repository: 'example/php-app',
  baseSha: 'base-php-001',
  headSha: 'head-php-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

async function fixture(caseName, side) {
  return readFile(
    new URL(`../../fixtures/php-laravel/${caseName}/${side}.php`, import.meta.url),
    'utf8',
  );
}

async function analyze(caseName) {
  const [beforeSource, afterSource] = await Promise.all([
    fixture(caseName, 'before'),
    fixture(caseName, 'after'),
  ]);

  return adapter.analyze({
    identity,
    path: 'app/Services/ExampleService.php',
    beforeSource,
    afterSource,
  });
}

test('format-only PHP change 會 COMPLETE 且不產生 semantic fact', async () => {
  const result = await analyze('format-only');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.equal(result.obligations[0].status, 'COMPLETE');
  assert.deepEqual(result.facts, []);
});

test('named argument expression 變更會輸出 CALL_ARGUMENT_CHANGED', async () => {
  const result = await analyze('named-argument-change');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'CALL_ARGUMENT_CHANGED');
  assert.equal(result.facts[0].subject, 'PaymentService::retry');
  assert.deepEqual(result.facts[0].properties, {
    callee: '$gateway->charge',
    argument: 'idempotencyKey',
    before: '$requestId',
    after: "$requestId . ':' . $attempt",
    changeSide: 'after',
  });
  assert.equal(result.facts[0].source.adapterId, 'php-laravel-v1');
});

test('DB::transaction wrapper 移除只輸出 generic CALL_REMOVED 並保持 partial coverage', async () => {
  const result = await analyze('transaction-removed');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'PARTIAL_PARSE');
  assert.ok(result.facts.some((fact) => (
    fact.kind === 'CALL_REMOVED'
    && fact.properties.callee === 'DB::transaction'
  )));
  assert.equal(
    result.facts.some((fact) => fact.kind === 'TRANSACTION_BOUNDARY_REMOVED'),
    false,
  );
  assert.deepEqual(result.diagnostics, ['UNRECOGNIZED_PHP_CHANGE']);
});

test('authorize call 移除只描述 CALL_REMOVED，不在 Adapter 解讀授權風險', async () => {
  const result = await analyze('authorization-removed');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.ok(result.facts.some((fact) => (
    fact.kind === 'CALL_REMOVED'
    && fact.properties.callee === '$this->authorize'
  )));
  assert.equal(
    result.facts.some((fact) => fact.kind === 'AUTHORIZATION_GUARD_REMOVED'),
    false,
  );
});

test('新增 standalone call 會輸出 CALL_ADDED 且 completeness 可被證明', async () => {
  const result = await analyze('call-added');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.ok(result.facts.some((fact) => (
    fact.kind === 'CALL_ADDED'
    && fact.properties.callee === '$this->audit'
  )));
});

test('未支援的一般 PHP semantic change 必須 PARTIAL_PARSE 而不是誤判安全', async () => {
  const result = await analyze('unsupported-operator-change');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'PARTIAL_PARSE');
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.diagnostics, ['UNRECOGNIZED_PHP_CHANGE']);
});

test('真實 PHP fact 沒有 interpreter 時會經既有 reducer 保留 Human Review', async () => {
  const [beforeSource, afterSource] = await Promise.all([
    fixture('named-argument-change', 'before'),
    fixture('named-argument-change', 'after'),
  ]);
  const request = {
    identity,
    path: 'app/Services/PaymentService.php',
    beforeSource,
    afterSource,
  };
  const initialResult = await adapter.analyze(request);
  const state = createAuthorityState(
    identity,
    createAnalysisContextBinding(initialResult),
  );

  const pipeline = await runAdapterPipeline(
    adapter,
    request,
    state,
    { timeoutMs: 2_000 },
  );

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'TARGETED');
  assert.match(
    pipeline.candidate.decision.reasons[0],
    /^FACT_UNHANDLED:php-/,
  );
});
