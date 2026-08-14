import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence } from '../src/evidence.js';

const provenance = {
  path: 'src/payment.js',
  startByte: 0,
  endByte: 10,
};

function evidence(overrides = {}) {
  return {
    id: 'EVIDENCE-001',
    source: 'adapter:javascript-v1',
    subject: 'entity:payment-service',
    kind: 'CALL_EDGE',
    complete: true,
    provenance,
    ...overrides,
  };
}

test('合法 evidence item 會保留 provenance 並通過 contract', () => {
  const result = validateEvidence({ items: [evidence()] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.items, [evidence()]);
});

test('缺欄位、未完成與非法 provenance 都會產生 deterministic blockers', () => {
  const result = validateEvidence({
    items: [
      evidence({ id: '', source: '', subject: '', complete: false }),
      evidence({ id: 'EVIDENCE-002', provenance: { ...provenance, endByte: 0 } }),
    ],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.blockers, [
    'EVIDENCE_COMPLETE_FALSE:unknown',
    'EVIDENCE_ID_MISSING',
    'EVIDENCE_PROVENANCE_INVALID:EVIDENCE-002',
    'EVIDENCE_SOURCE_MISSING',
    'EVIDENCE_SUBJECT_MISSING',
  ]);
});

test('重複 evidence id 不能由 confidence 取代 completeness', () => {
  const result = validateEvidence({
    items: [
      evidence({ complete: false, confidence: 1 }),
      evidence({ complete: true }),
    ],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.blockers, [
    'EVIDENCE_COMPLETE_FALSE:EVIDENCE-001',
    'EVIDENCE_DUPLICATE_ID:EVIDENCE-001',
  ]);
});

test('空 evidence collection 會 fail-closed', () => {
  assert.deepEqual(validateEvidence({ items: [] }), {
    valid: false,
    blockers: ['EVIDENCE_MISSING'],
    items: [],
  });
});
