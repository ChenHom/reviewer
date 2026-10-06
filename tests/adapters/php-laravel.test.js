import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createAnalysisContextBinding,
  validateAdapterResult,
} from '../../src/adapters/contracts.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';
import { PHP_LARAVEL_DOMAIN_INTERPRETERS } from '../../src/interpreters/php-laravel-domain.js';
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


async function runWithDomainInterpreters(caseName, path) {
  const [beforeSource, afterSource] = await Promise.all([
    fixture(caseName, 'before'),
    fixture(caseName, 'after'),
  ]);
  const request = {
    identity,
    path,
    beforeSource,
    afterSource,
  };
  const initialResult = await adapter.analyze(request);
  const state = createAuthorityState(
    identity,
    createAnalysisContextBinding(
      initialResult,
      PHP_LARAVEL_DOMAIN_INTERPRETERS,
    ),
  );

  return runAdapterPipeline(
    adapter,
    request,
    state,
    {
      timeoutMs: 2_000,
      factInterpreters: PHP_LARAVEL_DOMAIN_INTERPRETERS,
    },
  );
}

test('idempotencyKey 變更由 domain interpreter 轉成 payment blocker', async () => {
  const pipeline = await runWithDomainInterpreters(
    'named-argument-change',
    'app/Services/PaymentService.php',
  );

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'TARGETED');
  assert.deepEqual(
    pipeline.candidate.decision.reasons,
    ['PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED'],
  );
});

test('DB::transaction 移除由 domain interpreter 轉成 transaction blocker', async () => {
  const pipeline = await runWithDomainInterpreters(
    'transaction-removed',
    'app/Services/WalletService.php',
  );

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'FULL');
  assert.ok(
    pipeline.candidate.decision.reasons.includes('TRANSACTION_BOUNDARY_REMOVED'),
  );
});

test('authorize call 移除由 domain interpreter 轉成 authorization blocker', async () => {
  const pipeline = await runWithDomainInterpreters(
    'authorization-removed',
    'app/Services/OrderService.php',
  );

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'TARGETED');
  assert.deepEqual(
    pipeline.candidate.decision.reasons,
    ['AUTHORIZATION_GUARD_REMOVED'],
  );
});

test('domain interpreters 不得吞掉不認識的 generic fact', async () => {
  const pipeline = await runWithDomainInterpreters(
    'call-added',
    'app/Services/ExampleService.php',
  );

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.match(
    pipeline.candidate.decision.reasons[0],
    /^FACT_UNHANDLED:php-/,
  );
});

function inlineAnalyze(beforeSource, afterSource) {
  return adapter.analyze({
    identity,
    path: 'app/Services/InlineService.php',
    beforeSource,
    afterSource,
  });
}

function wrap(body) {
  return `<?php\n\nclass InlineService\n{\n    public function run($q)\n    {\n${body}\n    }\n}\n`;
}

test('closure 內的巢狀 call 會被抽出，unwrap transaction 只留下 CALL_REMOVED', async () => {
  const result = await inlineAnalyze(
    wrap('        \\DB::transaction(function () use ($q) {\n            $q->save();\n        });'),
    wrap('        $q->save();'),
  );

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.callee]),
    [['CALL_REMOVED', '\\DB::transaction']],
  );
});

test('鏈式 call 移除會輸出 ->method callee，且不放寬 completeness', async () => {
  const result = await inlineAnalyze(
    wrap('        return Model::query()->lockForUpdate()->find($q);'),
    wrap('        return Model::query()->find($q);'),
  );

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.callee]),
    [['CALL_REMOVED', '->lockForUpdate']],
  );
});

test('屬性鏈 receiver 會保留完整名稱', async () => {
  const result = await inlineAnalyze(
    wrap('        $this->adminDB->commit();\n        return 1;'),
    wrap('        return 1;'),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.callee]),
    [['CALL_REMOVED', '$this->adminDB->commit']],
  );
});

test('位置參數變更輸出 #index fact 但不 mask，維持 PARTIAL_PARSE', async () => {
  const result = await inlineAnalyze(
    wrap("        $q->update(['amount' => $q->amount - 1]);"),
    wrap("        $q->update(['amount' => $q->amount + 1]);"),
  );

  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'PARTIAL_PARSE');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'CALL_ARGUMENT_CHANGED');
  assert.deepEqual(result.facts[0].properties, {
    callee: '$q->update',
    argument: '#0',
    before: "['amount' => $q->amount - 1]",
    after: "['amount' => $q->amount + 1]",
    changeSide: 'after',
  });
});

test('含 closure 的位置參數不輸出 argument fact', async () => {
  const result = await inlineAnalyze(
    wrap('        $q->each(function ($row) { return 1; });'),
    wrap('        $q->each(function ($row) { return 2; });'),
  );

  assert.equal(result.complete, false);
  assert.deepEqual(result.facts, []);
});

test('只有空白差異的參數不產生 fact', async () => {
  const result = await inlineAnalyze(
    wrap('        $q->charge(idempotencyKey: $a . $b, amount: [1,2]);'),
    wrap('        $q->charge(\n            idempotencyKey: $a.$b,\n            amount: [1, 2]\n        );'),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.facts, []);
});

test('巢狀 call 的 named argument 變更輸出 fact 但不 mask', async () => {
  const result = await inlineAnalyze(
    wrap('        \\DB::transaction(function () use ($q) {\n            $q->charge(idempotencyKey: $a);\n        });'),
    wrap('        \\DB::transaction(function () use ($q) {\n            $q->charge(idempotencyKey: $b);\n        });'),
  );

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.argument]),
    [['CALL_ARGUMENT_CHANGED', 'idempotencyKey']],
  );
});
