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

test('運算子變更由 AST 解釋為 BINARY_OPERATOR_CHANGED，不會被誤判安全', async () => {
  const result = await analyze('unsupported-operator-change');

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.facts.map(({ kind, properties }) => [
    kind,
    properties.operatorBefore,
    properties.operatorAfter,
  ]), [['BINARY_OPERATOR_CHANGED', '+', '-']]);
});

test('沒有對應 fact 的 PHP semantic change 必須 PARTIAL_PARSE 而不是誤判安全', async () => {
  const result = await adapter.analyze({
    identity,
    path: 'app/Services/ExampleService.php',
    beforeSource: "<?php\n\nfunction label() {\n    return strtoupper('paid');\n}\n",
    afterSource: "<?php\n\nfunction label() {\n    return strtolower('paid');\n}\n",
  });

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
  return `<?php\n\nclass InlineService\n{\n    public function run($q, $a = 1, $b = 2)\n    {\n${body}\n    }\n}\n`;
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

test('鏈式 call 移除會輸出 ->method callee，並由 AST 解釋為完整', async () => {
  const result = await inlineAnalyze(
    wrap('        return Model::query()->lockForUpdate()->find($q);'),
    wrap('        return Model::query()->find($q);'),
  );

  assert.equal(result.complete, true);
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

test('無法被更細 fact 解釋的位置參數變更輸出 #index fallback fact，維持 PARTIAL_PARSE', async () => {
  const result = await inlineAnalyze(
    wrap("        $q->update(['amount' => floor($q->amount)]);"),
    wrap("        $q->update(['amount' => ceil($q->amount)]);"),
  );

  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'PARTIAL_PARSE');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'CALL_ARGUMENT_CHANGED');
  assert.deepEqual(result.facts[0].properties, {
    callee: '$q->update',
    argument: '#0',
    before: "['amount' => floor($q->amount)]",
    after: "['amount' => ceil($q->amount)]",
    changeSide: 'after',
  });
});

test('位置參數內的運算子變更由 BINARY_OPERATOR_CHANGED 解釋，不另外輸出 fallback fact', async () => {
  const result = await inlineAnalyze(
    wrap("        $q->update(['amount' => $q->amount - 1]);"),
    wrap("        $q->update(['amount' => $q->amount + 1]);"),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.facts.map(({ kind, properties }) => [kind, properties.before, properties.after]), [
    ['BINARY_OPERATOR_CHANGED', '$q->amount - 1', '$q->amount + 1'],
  ]);
});

test('含 closure 的位置參數不輸出 argument fact', async () => {
  const result = await inlineAnalyze(
    wrap('        $q->each(function ($row) { return floor($row); });'),
    wrap('        $q->each(function ($row) { return ceil($row); });'),
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

test('巢狀 call 的 named argument 變更輸出 fact，並由 AST 解釋為完整', async () => {
  const result = await inlineAnalyze(
    wrap('        \\DB::transaction(function () use ($q) {\n            $q->charge(idempotencyKey: $q->id);\n        });'),
    wrap('        \\DB::transaction(function () use ($q) {\n            $q->charge(idempotencyKey: $q->uuid);\n        });'),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.argument]),
    [['CALL_ARGUMENT_CHANGED', 'idempotencyKey']],
  );
});

test('括號包住的 receiver 與 enum case 沿用舊 callee 命名規則', async () => {
  const before = `<?php

class InlineService
{
    public function run($a, $b)
    {
        $days = (date_diff($a, $b))->format('%a');
        $bar = (new Foo())->bar();
        $label = Suit::Hearts->label();
        return [$days, $bar, $label];
    }
}
`;
  const after = before
    .replace("(date_diff($a, $b))->format('%a')", 'date_diff($a, $b)')
    .replace('(new Foo())->bar()', 'new Foo()')
    .replace('Suit::Hearts->label()', 'Suit::Hearts');
  const result = await inlineAnalyze(before, after);

  assert.deepEqual(
    result.facts.map(({ kind, properties, provenance }) => [
      kind,
      properties.callee,
      before.slice(provenance.startByte, provenance.startByte + 2),
    ]),
    [
      ['CALL_REMOVED', '->format', '->'],
      ['CALL_REMOVED', '->bar', '->'],
      ['CALL_REMOVED', 'Hearts->label', 'He'],
    ],
  );
});

test('trait method subject 包含 trait 名稱，匿名 class 只保留 method 名稱', async () => {
  const traitSource = (body) => `<?php\n\ntrait Auditable\n{\n    public function audit($q)\n    {\n${body}\n    }\n}\n`;
  const traitResult = await inlineAnalyze(traitSource('        $q->save();'), traitSource(''));
  assert.equal(traitResult.facts[0].subject, 'Auditable::audit');

  const anonymous = (body) => `<?php\n\nreturn new class () extends BaseController {\n    public function run()\n    {\n${body}\n    }\n};\n`;
  const anonymousResult = await inlineAnalyze(anonymous('        $this->check();'), anonymous(''));
  assert.equal(anonymousResult.facts[0].subject, 'run');
});

test('static:: call 與舊版相同不抽取', async () => {
  const result = await inlineAnalyze(wrap('        static::boot();'), wrap(''));

  assert.equal(result.complete, false);
  assert.deepEqual(result.facts, []);
});

test('PHP 8 已移除的語法（$str{0}）會以 PHP 7.4 語法 fallback 解析', async () => {
  const legacy = (body) => `<?php\n\nclass LegacyGateway\n{\n    public function first($s)\n    {\n${body}\n        return $s{0};\n    }\n}\n`;
  const unchanged = await inlineAnalyze(legacy(''), legacy(''));
  assert.equal(unchanged.complete, true);
  assert.deepEqual(unchanged.facts, []);

  const removed = await inlineAnalyze(legacy('        $this->verifySign($s);'), legacy(''));
  assert.deepEqual(
    removed.facts.map(({ kind, properties }) => [kind, properties.callee]),
    [['CALL_REMOVED', '$this->verifySign']],
  );
});

test('兩種語法都無法解析時回傳 PHP_PARSE_ERROR', async () => {
  const result = await inlineAnalyze(wrap('        $q->save();'), wrap('        $q->save(;'));

  assert.equal(result.complete, false);
  assert.equal(result.reasonCode, 'PHP_PARSE_ERROR');
});

test('回傳值換成另一個非常數運算式時判為 PARTIAL_PARSE', async () => {
  const result = await inlineAnalyze(
    wrap('        return $q ? 1 : $this->fallback();'),
    wrap('        return floor($q);'),
  );

  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'PARTIAL_PARSE');
});

test('trailing comma、引號種類、array() 語法與括號差異不影響 AST，判為 COMPLETE 且無 fact', async () => {
  const result = await inlineAnalyze(
    wrap("        return $q->send(array('a' => 'x', 'b' => ($q->n + 1)));"),
    wrap('        return $q->send([\n            "a" => "x",\n            "b" => $q->n + 1,\n        ]);'),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.facts, []);
});

test('移除 early-exit guard 輸出 GUARD_REMOVED 並判為完整', async () => {
  const result = await inlineAnalyze(
    wrap("        if (!$q->valid()) {\n            throw new \\Exception('invalid');\n        }\n        return $q->id;"),
    wrap('        return $q->id;'),
  );

  assert.equal(result.complete, true);
  const guard = result.facts.find(({ kind }) => kind === 'GUARD_REMOVED');
  assert.deepEqual(guard.properties, {
    condition: '!$q->valid()',
    exit: 'throw',
    changeSide: 'before',
  });
  assert.equal(guard.subject, 'InlineService::run');
});

test('非 guard 的 if 被移除時仍為 PARTIAL_PARSE', async () => {
  const result = await inlineAnalyze(
    wrap("        if ($q->valid()) {\n            $total = 1;\n        }\n        return $q->id;"),
    wrap('        return $q->id;'),
  );

  assert.equal(result.complete, false);
});

test('property 陣列移除元素輸出 ARRAY_ITEM_REMOVED 並帶 container', async () => {
  const controller = (items) => `<?php\n\nreturn new class () extends BaseController {\n    protected $beforeActionList = [${items}];\n};\n`;
  const result = await inlineAnalyze(
    controller("'verifyToken', 'authorize'"),
    controller("'verifyToken'"),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.facts.map(({ kind, properties }) => [kind, properties]), [[
    'ARRAY_ITEM_REMOVED',
    {
      container: 'property:$beforeActionList',
      key: null,
      value: "'authorize'",
      changeSide: 'before',
    },
  ]]);
});

test('Route::group middleware 移除輸出帶 key path 的 ARRAY_ITEM_REMOVED', async () => {
  const route = (items) => `<?php\n\nRoute::group(['middleware' => [${items}]], function () {\n    Route::get('/', 'HomeController@index');\n});\n`;
  const result = await inlineAnalyze(
    route("'auth:admin', 'loginBasic:admin'"),
    route("'loginBasic:admin'"),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.container, properties.value]),
    [['ARRAY_ITEM_REMOVED', 'Route::group#0[middleware]', "'auth:admin'"]],
  );
});

function factSummary(result) {
  return result.facts.map(({ kind, properties }) => {
    const { changeSide, ...rest } = properties;
    assert.equal(changeSide, kind === 'CALL_REMOVED' ? 'before' : 'after');
    return [kind, rest];
  });
}

test('字面值變更輸出帶 container 的 LITERAL_CHANGED 並判為完整', async () => {
  const cases = [
    ['        return $q->take(10);', '        return $q->take(11);', { container: '$q->take#0', before: '10', after: '11' }],
    ["        return 'paid';", "        return \"refunded\";", { container: 'return', before: "'paid'", after: '"refunded"' }],
    ['        return $q->limit(-1);', '        return $q->limit(1);', { container: '$q->limit#0', before: '-1', after: '1' }],
    ['        $q->active = true;', '        $q->active = null;', { container: 'file', before: 'true', after: 'null' }],
    ["        return ['fee' => 1.5];", "        return ['fee' => '1.5'];", { container: 'return[fee]', before: '1.5', after: "'1.5'" }],
  ];
  for (const [before, after, properties] of cases) {
    const result = await inlineAnalyze(wrap(before), wrap(after));
    assert.equal(result.complete, true, after);
    assert.deepEqual(factSummary(result), [['LITERAL_CHANGED', properties]], after);
  }

  const constant = await inlineAnalyze(
    "<?php\n\nclass Fee\n{\n    const RATE = 3;\n}\n",
    "<?php\n\nclass Fee\n{\n    const RATE = 30;\n}\n",
  );
  assert.deepEqual(factSummary(constant), [['LITERAL_CHANGED', { container: 'const:RATE', before: '3', after: '30' }]]);
});

test('條件或布林值被反轉時輸出 EXPRESSION_NEGATED', async () => {
  const negated = await inlineAnalyze(
    wrap("        if ($q->paid()) {\n            $q->ship();\n        }"),
    wrap("        if (!($q->paid())) {\n            $q->ship();\n        }"),
  );
  assert.equal(negated.complete, true);
  assert.deepEqual(factSummary(negated), [['EXPRESSION_NEGATED', { container: 'if', before: '$q->paid()', after: '!($q->paid())' }]]);

  const unnegated = await inlineAnalyze(wrap('        return !$q;'), wrap('        return $q;'));
  assert.deepEqual(factSummary(unnegated), [['EXPRESSION_NEGATED', { container: 'return', before: '!$q', after: '$q' }]]);

  const ternary = await inlineAnalyze(wrap('        return $q ? 1 : 2;'), wrap('        return !$q ? 1 : 2;'));
  assert.deepEqual(ternary.facts.map(({ properties }) => properties.container), ['ternary']);
});

test('回傳值換成常數（或從常數換掉）時輸出 RETURN_VALUE_CHANGED', async () => {
  const toNull = await inlineAnalyze(wrap('        return $q->total() + 1;'), wrap('        return null;'));
  assert.equal(toNull.complete, true);
  assert.deepEqual(factSummary(toNull), [
    ['CALL_REMOVED', { callee: '$q->total' }],
    ['RETURN_VALUE_CHANGED', { before: '$q->total() + 1', after: 'null' }],
  ]);

  const cases = [
    ['        return $q->rows();', '        return [];'],
    ['        return $q->status;', '        return Status::Paid;'],
    ["        return ['a' => 1, 'b' => [true]];", '        return $q->all();'],
    ['        return $q->total();', '        return;'],
    ['        return;', '        return $q;'],
  ];
  for (const [before, after] of cases) {
    const result = await inlineAnalyze(wrap(before), wrap(after));
    assert.equal(result.complete, true, after);
    assert.ok(result.facts.some(({ kind }) => kind === 'RETURN_VALUE_CHANGED'), after);
  }

  // 兩邊都不是常數：維持未解釋。
  for (const after of ['        return ceil($q);', '        return [$q];', '        return $q->total();']) {
    const result = await inlineAnalyze(wrap('        return floor($q);'), wrap(after));
    assert.equal(result.complete, false, after);
  }
});

test('參數只有順序不同時輸出 CALL_ARGUMENTS_REORDERED', async () => {
  const cases = [
    ['        return $q->between($a, $b);', '        return $q->between($b, $a);', '$q->between', '$a, $b', '$b, $a'],
    ['        return max($a, $b, 1);', '        return max(1, $b, $a);', 'max', '$a, $b, 1', '1, $b, $a'],
    ['        return new Money($a, $b);', '        return new Money($b, $a);', 'new Money', '$a, $b', '$b, $a'],
    ['        return $q->pay(to: $a, from: $b);', '        return $q->pay(from: $b, to: $a);', '$q->pay', 'to: $a, from: $b', 'from: $b, to: $a'],
  ];
  for (const [before, after, callee, argsBefore, argsAfter] of cases) {
    const result = await inlineAnalyze(wrap(before), wrap(after));
    assert.equal(result.complete, true, after);
    assert.deepEqual(factSummary(result), [['CALL_ARGUMENTS_REORDERED', { callee, before: argsBefore, after: argsAfter }]], after);
  }

  // 內容不同（不只是順序）時不是 reorder。
  const changed = await inlineAnalyze(wrap('        return max($a, $b);'), wrap('        return max($b, $b);'));
  assert.ok(!changed.facts.some(({ kind }) => kind === 'CALL_ARGUMENTS_REORDERED'));
});

test('同一位置換成另一個 method 時由 CALL_REMOVED / CALL_ADDED 解釋', async () => {
  const result = await inlineAnalyze(
    wrap('        return $q->where($a)->first();'),
    wrap('        return $q->where($a)->firstOrFail();'),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.facts.map(({ kind, properties }) => [kind, properties.callee]), [
    ['CALL_ADDED', '->firstOrFail'],
    ['CALL_REMOVED', '->first'],
  ]);

  // method 換掉的同時參數也變了：參數照常比較。
  const withArgument = await inlineAnalyze(wrap('        return $q->find($a);'), wrap('        return $q->findOrFail(floor($a));'));
  assert.equal(withArgument.complete, false);
});

test('鏈中移除或新增的 call 與鄰近 call 同類型時仍由 CALL_REMOVED / CALL_ADDED 解釋', async () => {
  const cases = [
    ['        return Curl::to($a)->withData($q)->asJson()->post();', '        return Curl::to($a)->withData($q)->post();', 'CALL_REMOVED', '->asJson'],
    ["        return $q->where('a', 1)->orWhere('b', 2)->orWhere('c', 3);", "        return $q->where('a', 1)->orWhere('c', 3);", 'CALL_REMOVED', '->orWhere'],
    ['        return $q->select($a)->first();', '        return $q->select($a)->lockForUpdate()->first();', 'CALL_ADDED', '->lockForUpdate'],
  ];
  for (const [before, after, kind, callee] of cases) {
    const result = await inlineAnalyze(wrap(before), wrap(after));
    assert.equal(result.complete, true, after);
    assert.deepEqual(result.facts.map((fact) => [fact.kind, fact.properties.callee]), [[kind, callee]], after);
  }
});

test('運算式 list 中一對一替換的運算式直接比較（for 條件、echo）', async () => {
  const loop = await inlineAnalyze(
    wrap('        for ($i = 0; $i <= $q; $i++) {\n            $a->x();\n        }'),
    wrap('        for ($i = 0; $i < $q; $i++) {\n            $a->x();\n        }'),
  );
  assert.equal(loop.complete, true);
  assert.deepEqual(loop.facts.map(({ kind, properties }) => [kind, properties.operatorAfter]), [['BINARY_OPERATOR_CHANGED', '<']]);

  const negatedLoop = await inlineAnalyze(wrap('        while ($q) {\n            $a->x();\n        }'), wrap('        while (!$q) {\n            $a->x();\n        }'));
  assert.deepEqual(negatedLoop.facts.map(({ properties }) => properties.container), ['while']);

  const echo = await inlineAnalyze(wrap('        echo $a, $b;'), wrap('        echo $a, floor($b);'));
  assert.equal(echo.complete, false);
});

test('變數名稱的差異無法以 scope 內改名解釋時輸出 VARIABLE_CHANGED', async () => {
  const partial = await inlineAnalyze(
    wrap('        $x = $a;\n        return $x + $x;'),
    wrap('        $x = $a;\n        return $x + $xRenamed;'),
  );
  assert.equal(partial.complete, true);
  assert.deepEqual(factSummary(partial), [['VARIABLE_CHANGED', { container: 'return', before: '$x', after: '$xRenamed' }]]);

  const parameter = await inlineAnalyze(method('$amount', '        return $amount;'), method('$value', '        return $value;'));
  assert.equal(parameter.complete, true);
  assert.deepEqual(parameter.facts.map(({ properties }) => [properties.container, properties.before, properties.after]), [
    ['param', '$amount', '$value'],
    ['return', '$amount', '$value'],
  ]);

  // 一致的區域變數改名仍以 canonical 名稱判為等價，不輸出 fact。
  const consistent = await inlineAnalyze(
    method('$id', '        $cash = Cash::find($id);\n        return $cash->amount;'),
    method('$id', '        $row = Cash::find($id);\n        return $row->amount;'),
  );
  assert.equal(consistent.complete, true);
  assert.deepEqual(consistent.facts, []);

  // 變數變更以外仍有未解釋的差異時，不採用 VARIABLE_CHANGED 的結果。
  const mixed = await inlineAnalyze(
    wrap('        $x = $a;\n        return floor($x);'),
    wrap('        $x = $a;\n        return ceil($y);'),
  );
  assert.equal(mixed.complete, false);
  assert.ok(!mixed.facts.some(({ kind }) => kind === 'VARIABLE_CHANGED'));
});

test('soundness：沒有 fact 時 COMPLETE 只發生在 AST 完全相同', async () => {
  const cases = [
    ["return 'a';", "return 'b';"],
    ['return 1;', 'return 2;'],
    ['return $q;', 'return !$q;'],
    ['return foo($q);', 'return bar($q);'],
    ['$q->a = 1;', '$q->b = 1;'],
    ['return $q ?? 1;', 'return $q ?: 1;'],
  ];

  for (const [before, after] of cases) {
    const result = await inlineAnalyze(wrap(`        ${before}`), wrap(`        ${after}`));
    assert.ok(
      result.complete === false || result.facts.length > 0,
      `${before} → ${after} 不可無 fact 地判為 COMPLETE`,
    );
  }
});

function method(params, body) {
  return `<?php\n\nclass RenameService\n{\n    public function run(${params})\n    {\n${body}\n    }\n}\n`;
}

test('scope 內一致的區域變數改名判為 COMPLETE 且無 fact', async () => {
  const cases = [
    [
      method('$id', '        $cash = Cash::find($id);\n        $cash->save();\n        return $cash->amount;'),
      method('$id', '        $cashRow = Cash::find($id);\n        $cashRow->save();\n        return $cashRow->amount;'),
    ],
    [
      method('$rows', '        $sum = 0;\n        foreach ($rows as $row) {\n            $sum += $row;\n        }\n        return $sum;'),
      method('$rows', '        $total = 0;\n        foreach ($rows as $item) {\n            $total += $item;\n        }\n        return $total;'),
    ],
    [
      method('$q', '        $limit = 10;\n        return $q->each(function ($x) use ($limit) {\n            return $x < $limit;\n        });'),
      method('$q', '        $max = 10;\n        return $q->each(function ($x) use ($max) {\n            return $x < $max;\n        });'),
    ],
    [
      method('', "        try {\n            return 1;\n        } catch (\\Exception $e) {\n            report($e);\n        }"),
      method('', "        try {\n            return 1;\n        } catch (\\Exception $error) {\n            report($error);\n        }"),
    ],
    // 一致的交換（bijection）仍等價
    [
      method('', '        $a = 1;\n        $b = 2;\n        return $a - $b;'),
      method('', '        $b = 1;\n        $a = 2;\n        return $b - $a;'),
    ],
  ];

  for (const [before, after] of cases) {
    const result = await inlineAnalyze(before, after);
    assert.equal(result.complete, true, after);
    assert.deepEqual(result.facts, [], after);
  }
});

test('不安全的改名絕不判為無 fact 的 COMPLETE', async () => {
  const cases = [
    ['合併兩個變數', method('', '        $a = 1;\n        $b = 2;\n        return $a + $b;'), method('', '        $a = 1;\n        $a = 2;\n        return $a + $a;')],
    ['只改部分出現處', method('', '        $a = 1;\n        return $a;'), method('', '        $a = 1;\n        return $b;')],
    ['參數改名（named argument API）', method('$amount', '        return $amount;'), method('$value', '        return $value;')],
    ['closure 參數改名', method('$q', '        return $q->map(function ($row) {\n            return $row;\n        });'), method('$q', '        return $q->map(function ($item) {\n            return $item;\n        });')],
    ['compact 依賴變數名稱', method('', "        $total = 1;\n        return compact('total');"), method('', "        $sum = 1;\n        return compact('total');")],
    ['variable variable', method('$name', '        $total = 1;\n        return $$name;'), method('$name', '        $sum = 1;\n        return $$name;')],
    ['extract 寫入區域變數', method('$data', '        extract($data);\n        return $total;'), method('$data', '        extract($data);\n        return $sum;')],
    ['include 可讀取區域變數', method('', "        $title = 'x';\n        return include 'view.php';"), method('', "        $heading = 'x';\n        return include 'view.php';")],
    ['global 變數', method('', '        global $config;\n        return $config;'), method('', '        global $settings;\n        return $settings;')],
    ['magic local', method('', "        file_get_contents('http://x');\n        return $http_response_header;"), method('', "        file_get_contents('http://x');\n        return $headers;")],
    ['頂層變數是 global', "<?php\n\n$config = 1;\nreturn $config;\n", "<?php\n\n$settings = 1;\nreturn $settings;\n"],
    ['只改賦值處，字串內仍用舊名', method('$key', '        $token = substr($key, -4);\n        return "token={$token}";'), method('$key', '        $tokenRenamed = substr($key, -4);\n        return "token={$token}";')],
    ['合併成另一個既有變數', method('', "        $config = load();\n        $payObject = make();\n        return [$config['v'], $payObject];"), method('', "        $payObject = load();\n        $payObject = make();\n        return [$payObject['v'], $payObject];")],
    [
      'use function 別名的 compact 依賴變數名稱',
      "<?php\n\nnamespace App;\n\nuse function compact as pack_vars;\n\nclass Report\n{\n    public function payload(int $amount)\n    {\n        $total = $amount * 2;\n        return pack_vars('total');\n    }\n}\n",
      "<?php\n\nnamespace App;\n\nuse function compact as pack_vars;\n\nclass Report\n{\n    public function payload(int $amount)\n    {\n        $sum = $amount * 2;\n        return pack_vars('total');\n    }\n}\n",
    ],
    [
      'group use 別名的 extract 寫入區域變數',
      "<?php\n\nuse function Helpers\\{format, extract as unpack_vars};\n\nfunction run($data)\n{\n    unpack_vars($data);\n    return $total;\n}\n",
      "<?php\n\nuse function Helpers\\{format, extract as unpack_vars};\n\nfunction run($data)\n{\n    unpack_vars($data);\n    return $sum;\n}\n",
    ],
    ['頂層 closure 的 use 綁定 global', "<?php\n\nreturn function () use ($config) {\n    return $config;\n};\n", "<?php\n\nreturn function () use ($settings) {\n    return $settings;\n};\n"],
  ];

  for (const [label, before, after] of cases) {
    const result = await inlineAnalyze(before, after);
    assert.ok(result.complete === false || result.facts.length > 0, label);
  }
});

test('改名同時有其他變更時仍輸出對應 fact', async () => {
  const result = await inlineAnalyze(
    method('$id', '        $cash = Cash::find($id);\n        $cash->lock();\n        return $cash->amount < 10;'),
    method('$id', '        $row = Cash::find($id);\n        return $row->amount <= 10;'),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.facts.map(({ kind, properties }) => [kind, properties.callee ?? properties.operatorAfter]),
    [['CALL_REMOVED', '$cash->lock'], ['BINARY_OPERATOR_CHANGED', '<=']],
  );
});


test('排版變更讓 __LINE__ 或 __halt_compiler offset 改變時不可判為無 fact 的 COMPLETE', async () => {
  const lineBefore = "<?php\n\nfunction where()\n{\n    return __LINE__;\n}\n";
  const lineAfter = "<?php\n\n// moved down\nfunction where()\n{\n    return __LINE__;\n}\n";
  const shifted = await inlineAnalyze(lineBefore, lineAfter);
  assert.equal(shifted.complete, false);
  assert.deepEqual(shifted.facts, []);

  // __LINE__ 之後的排版變更不影響其值，仍可 reduce。
  const below = await inlineAnalyze(lineBefore, `${lineBefore}// trailing comment\n`);
  assert.equal(below.complete, true);
  assert.deepEqual(below.facts, []);

  const halt = await inlineAnalyze(
    "<?php\n\necho __COMPILER_HALT_OFFSET__;\n__halt_compiler();data",
    "<?php\n\n// shifted\necho __COMPILER_HALT_OFFSET__;\n__halt_compiler();data",
  );
  assert.equal(halt.complete, false);
});

test('canonical 改名不可與保留原名的變數（如參數 $__rv0）碰撞', async () => {
  const cases = [
    ['function f($__rv0)\n{\n    $x = 2;\n    return $x;\n}', 'function f($__rv0)\n{\n    $x = 2;\n    return $__rv0;\n}'],
    [
      'function g($order)\n{\n    $amount = 100;\n    $doubled = array_map(function ($__rv0) {\n        return $__rv0 * 2;\n    }, [$amount]);\n    return $amount;\n}',
      'function g($order)\n{\n    $amount = 100;\n    $doubled = array_map(function ($__rv0) {\n        return $__rv0 * 2;\n    }, [$amount]);\n    return $__rv0;\n}',
    ],
    [
      'function refund($gateway, $__rv0)\n{\n    $amount = 5;\n    return $gateway->refund($amount);\n}',
      'function refund($gateway, $__rv0)\n{\n    $amount = 5;\n    return $gateway->refund($__rv0);\n}',
    ],
  ];

  for (const [before, after] of cases) {
    const result = await inlineAnalyze(`<?php\n\n${before}\n`, `<?php\n\n${after}\n`);
    assert.ok(result.complete === false || result.facts.length > 0, after);
  }
});

test('__COMPILER_HALT_OFFSET__ 以終止符之後的位置比較', async () => {
  const halt = (call) => `<?php\n\necho __COMPILER_HALT_OFFSET__;\n${call}data`;
  for (const [before, after] of [
    ['__halt_compiler();', '__halt_compiler( );'],
    ['__halt_compiler();', '__halt_compiler(/*c*/);'],
    ['__halt_compiler()?>', '__halt_compiler() ?>'],
  ]) {
    const result = await inlineAnalyze(halt(before), halt(after));
    assert.equal(result.complete, false, after);
  }

  const same = await inlineAnalyze(halt('__halt_compiler();'), halt('__halt_compiler();'));
  assert.equal(same.complete, true);
});

test('PHP 7 與 PHP 8 語法結論不同時不判為等價（PHP_GRAMMAR_DIVERGENCE）', async () => {
  const precedence = await inlineAnalyze(
    wrap('        return "total: " . $q + 1;'),
    wrap('        return "total: " . ($q + 1);'),
  );
  assert.equal(precedence.complete, false);
  assert.equal(precedence.reasonCode, 'PHP_GRAMMAR_DIVERGENCE');

  // 單行 attribute 在 PHP 7 是註解：拆成兩行會讓 function 被定義。
  const attribute = await inlineAnalyze(
    '<?php\n\n#[Pure] function f() { return 1; }\n',
    '<?php\n\n#[Pure]\nfunction f() { return 1; }\n',
  );
  assert.equal(attribute.complete, false);

  // 兩種語法下都等價的排版變更仍可 reduce（含 attribute 的 PHP 8 檔案）。
  const formatOnly = await inlineAnalyze(
    '<?php\n\n#[Pure]\nfunction f()\n{\n    return 1;\n}\n',
    '<?php\n\n// note\n#[Pure]\nfunction f() {\n  return 1;\n}\n',
  );
  assert.equal(formatOnly.complete, true);
  assert.deepEqual(formatOnly.facts, []);
});

test('PHP 7 字串 assert() 與 spread 參數的 parse_str 視為 name-sensitive', async () => {
  const notReduced = [
    [method('', "        $amount = 1;\n        assert('$amount > 0');\n        return 1;"), method('', "        $total = 1;\n        assert('$amount > 0');\n        return 1;")],
    [method('$s, $r', '        $total = 1;\n        parse_str($s, ...$r);\n        return $total;'), method('$s, $r', '        $sum = 1;\n        parse_str($s, ...$r);\n        return $sum;')],
  ];
  for (const [before, after] of notReduced) {
    const result = await inlineAnalyze(before, after);
    assert.ok(result.complete === false || result.facts.length > 0, after);
  }

  // 非字串的 assert 不影響改名正規化。
  const reduced = await inlineAnalyze(
    method('', '        $amount = 1;\n        assert($amount > 0);\n        return $amount;'),
    method('', '        $total = 1;\n        assert($total > 0);\n        return $total;'),
  );
  assert.equal(reduced.complete, true);
  assert.deepEqual(reduced.facts, []);
});
