import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateImpact } from '../src/impact.js';

const provenance = {
  path: 'src/payment.js',
  startByte: 0,
  endByte: 10,
};

const nodes = [
  { id: 'entity:payment-service' },
  { id: 'entity:ledger' },
];

function edge(overrides = {}) {
  return {
    source: 'entity:payment-service',
    target: 'entity:ledger',
    kind: 'CALL_EDGE',
    provenance,
    ...overrides,
  };
}

test('合法 impact edge 會去重並保留 provenance', () => {
  const result = evaluateImpact({
    nodes,
    edges: [edge(), edge()],
    requiredSubjects: ['entity:payment-service'],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.edges, [edge()]);
});

test('edge 指向不存在 node 會產生 unresolved blocker', () => {
  const result = evaluateImpact({
    nodes,
    edges: [edge({ target: 'entity:missing' })],
    requiredSubjects: ['entity:payment-service'],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.blockers, ['IMPACT_EDGE_UNRESOLVED']);
});

test('required subject 沒有可驗證 edge 會產生 subject blocker', () => {
  const result = evaluateImpact({
    nodes,
    edges: [],
    requiredSubjects: ['entity:payment-service'],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.blockers, ['IMPACT_SUBJECT_UNRESOLVED']);
});

test('缺 provenance 或零長度 range 都不能成為 impact evidence', () => {
  const result = evaluateImpact({
    nodes,
    edges: [edge({ provenance: { ...provenance, endByte: 0 } })],
    requiredSubjects: ['entity:payment-service'],
  });

  assert.deepEqual(result.blockers, ['IMPACT_EDGE_UNRESOLVED']);
});
