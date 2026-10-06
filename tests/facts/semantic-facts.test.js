import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnalysisContextBinding,
  sameAnalysisContextBinding,
  validateAdapterResult,
} from '../../src/adapters/contracts.js';
import { normalizeAdapterResult } from '../../src/adapters/normalize.js';
import { interpretSemanticFacts } from '../../src/facts/interpreter.js';
import { createAuthorityState } from '../../src/publication.js';
import { runAdapterPipeline } from '../../src/runner.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-fact-001',
  headSha: 'head-fact-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

function fact(id = 'fact-001', overrides = {}) {
  return {
    id,
    kind: 'CALL_ARGUMENT_CHANGED',
    subject: 'ExampleService::run',
    properties: {
      z: 'last',
      a: 'first',
    },
    provenance: {
      path: 'src/Example.php',
      startByte: 10,
      endByte: 20,
    },
    source: {
      adapterId: 'semantic-reference-v1',
      adapterVersion: '1.0.0',
    },
    ...overrides,
  };
}

function adapterResult(facts = [fact()]) {
  return {
    adapterSet: [{
      id: 'semantic-reference-v1',
      version: '1.0.0',
      languages: ['php'],
      capabilities: [
        'changed-regions',
        'runtime-context',
        'coverage-obligations',
        'semantic-facts',
      ],
    }],
    obligations: [{
      id: 'COV-FACT-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{
        path: 'src/Example.php',
        startByte: 0,
        endByte: 30,
        language: 'php',
        adapterId: 'semantic-reference-v1',
        runtimeContext: {
          namespace: 'server',
          id: 'server:php',
          version: '8.4',
          source: 'adapter',
        },
      }],
    }],
    facts,
    diagnostics: [],
    evidenceReferences: [],
    complete: true,
  };
}

function interpreter(id, version, interpret) {
  return { id, version, interpret };
}

function stateFor(result, interpreters = []) {
  return createAuthorityState(
    identity,
    createAnalysisContextBinding(result, interpreters),
  );
}

test('semantic fact contract 合法時會保留 provenance、source 並 deterministic normalization', () => {
  const result = adapterResult([
    fact('fact-002', {
      provenance: { path: 'src/Z.php', startByte: 20, endByte: 30 },
    }),
    fact('fact-001'),
  ]);

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });

  const normalized = normalizeAdapterResult({ identity, adapterResult: result });
  assert.deepEqual(
    normalized.semanticFacts.map((item) => item.id),
    ['fact-001', 'fact-002'],
  );
  assert.deepEqual(normalized.semanticFacts[0].properties, {
    a: 'first',
    z: 'last',
  });
  assert.deepEqual(normalized.semanticFacts[0].source, {
    adapterId: 'semantic-reference-v1',
    adapterVersion: '1.0.0',
  });
});

test('semantic-facts capability 已宣告但 facts 缺失時 AdapterResult 必須無效', () => {
  const result = adapterResult();
  delete result.facts;

  const validation = validateAdapterResult(result);

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors, ['ADAPTER_FACTS_MISSING']);
});

test('duplicate fact id 與 malformed provenance 必須 fail-closed', () => {
  const duplicate = adapterResult([fact('fact-001'), fact('fact-001')]);
  assert.equal(validateAdapterResult(duplicate).valid, false);
  assert.ok(validateAdapterResult(duplicate).errors.includes('FACT_DUPLICATE_ID:fact-001'));

  const malformed = adapterResult([
    fact('fact-001', {
      provenance: { path: 'src/Example.php', startByte: 10, endByte: 10 },
    }),
  ]);
  assert.equal(validateAdapterResult(malformed).valid, false);
  assert.ok(
    validateAdapterResult(malformed).errors.includes('FACT_PROVENANCE_INVALID:fact-001'),
  );
});

test('沒有受信任 interpreter 的 fact 必須保留 Human Review', async () => {
  const result = adapterResult();
  const pipeline = await runAdapterPipeline(
    { analyze: async () => result },
    { identity },
    stateFor(result),
    { timeoutMs: 50 },
  );

  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'TARGETED');
  assert.deepEqual(pipeline.candidate.decision.reasons, ['FACT_UNHANDLED:fact-001']);
});

test('受信任 interpreter 明確處理且沒有 blocker 時才可沿用既有 reduction', async () => {
  const result = adapterResult();
  const pipeline = await runAdapterPipeline(
    { analyze: async () => result },
    { identity },
    stateFor(result, [
      interpreter('allow-reference', '1.0.0', () => ({ handled: true, blockers: [] })),
    ]),
    {
      timeoutMs: 50,
      factInterpreters: [
        interpreter('allow-reference', '1.0.0', () => ({ handled: true, blockers: [] })),
      ],
    },
  );

  assert.equal(
    pipeline.candidate.decision.status,
    'NOT_SELECTED_FOR_HUMAN_REVIEW',
  );
});

test('interpreter exception 必須轉成 analyzer blocker 並採 Full Review', async () => {
  const result = adapterResult();
  const pipeline = await runAdapterPipeline(
    { analyze: async () => result },
    { identity },
    stateFor(result, [
      interpreter('throw-reference', '1.0.0', () => {
        throw new Error('interpreter failure');
      }),
    ]),
    {
      timeoutMs: 50,
      factInterpreters: [
        interpreter('throw-reference', '1.0.0', () => {
          throw new Error('interpreter failure');
        }),
      ],
    },
  );

  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'FULL');
  assert.deepEqual(
    pipeline.candidate.decision.reasons,
    ['ANALYZER_FACT_INTERPRETER_FAILED:throw-reference:fact-001'],
  );
});

test('增加 unresolved semantic fact 不得把 Human Review 變成 NOT_SELECTED', () => {
  const assessment = interpretSemanticFacts(
    [fact('fact-001'), fact('fact-002')],
    [
      interpreter('risk-reference', '1.0.0', (item) => (
        item.id === 'fact-001'
          ? { handled: true, blockers: ['risk:known'] }
          : null
      )),
    ],
  );

  assert.deepEqual(assessment.handledFactIds, ['fact-001']);
  assert.deepEqual(assessment.unhandledFactIds, ['fact-002']);
  assert.deepEqual(
    assessment.blockers,
    ['FACT_UNHANDLED:fact-002', 'risk:known'],
  );
});


test('Fact properties 非 JSON-safe 時必須在 Adapter contract fail-closed', () => {
  const circular = {};
  circular.self = circular;

  const invalidValues = [
    { value: undefined },
    { value: 1n },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: () => true },
    { value: new Date('2026-01-01T00:00:00Z') },
    { value: circular },
  ];

  for (const properties of invalidValues) {
    const validation = validateAdapterResult(adapterResult([
      fact('fact-json-invalid', { properties }),
    ]));
    assert.equal(validation.valid, false);
    assert.ok(
      validation.errors.includes('FACT_PROPERTIES_INVALID:fact-json-invalid'),
    );
  }
});

test('semantic facts 內容改變時 AnalysisContextBinding 必須改變', () => {
  const before = adapterResult([fact('fact-001')]);
  const after = adapterResult([
    fact('fact-001', {
      properties: { a: 'changed', z: 'last' },
    }),
  ]);

  const beforeBinding = createAnalysisContextBinding(before);
  const afterBinding = createAnalysisContextBinding(after);

  assert.notEqual(beforeBinding.semanticFactsDigest, afterBinding.semanticFactsDigest);
  assert.equal(sameAnalysisContextBinding(beforeBinding, afterBinding), false);
});

test('interpreter version 改變時 AnalysisContextBinding 必須改變', () => {
  const result = adapterResult();
  const v1 = createAnalysisContextBinding(result, [
    interpreter('payment-policy', '1.0.0', () => ({ handled: false })),
  ]);
  const v2 = createAnalysisContextBinding(result, [
    interpreter('payment-policy', '2.0.0', () => ({ handled: false })),
  ]);

  assert.notEqual(v1.interpreterSetDigest, v2.interpreterSetDigest);
  assert.equal(sameAnalysisContextBinding(v1, v2), false);
});

test('裸 function interpreter 不再是合法 executable interpreter', () => {
  const result = adapterResult();

  assert.throws(
    () => createAnalysisContextBinding(result, [() => ({ handled: true })]),
    /INTERPRETER_SET_INVALID/,
  );

  const assessment = interpretSemanticFacts(
    [fact('fact-001')],
    [() => ({ handled: true, blockers: [] })],
  );
  assert.deepEqual(assessment.blockers, ['ANALYZER_FACT_INTERPRETER_SET_INVALID']);
});
