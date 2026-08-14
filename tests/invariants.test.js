import test from 'node:test';
import assert from 'node:assert/strict';
import { mapInvariants } from '../src/invariants.js';

const provenance = {
  path: 'src/payment.js',
  startByte: 0,
  endByte: 10,
};

function mapping(overrides = {}) {
  return {
    invariantId: 'INV-NO-DUPLICATE-CHARGE',
    subject: 'entity:payment-service',
    provenance,
    evidenceProvenance: provenance,
    ...overrides,
  };
}

test('合法 invariant mapping 只提供可驗證 fact，不直接產生 reduction decision', () => {
  const result = mapInvariants({
    changedSubjects: ['entity:payment-service'],
    mappings: [mapping()],
    requiredInvariants: ['INV-NO-DUPLICATE-CHARGE'],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.mappings, [mapping()]);
  assert.equal('decision' in result, false);
});

test('空 required invariant set 會 fail-closed', () => {
  const result = mapInvariants({
    changedSubjects: ['entity:payment-service'],
    mappings: [],
    requiredInvariants: [],
  });

  assert.deepEqual(result.blockers, ['INVARIANT_REQUIRED_SET_MISSING']);
});

test('required invariant 缺 mapping 會產生 stable blocker', () => {
  const result = mapInvariants({
    changedSubjects: ['entity:payment-service'],
    mappings: [],
    requiredInvariants: ['INV-NO-DUPLICATE-CHARGE'],
  });

  assert.deepEqual(result.blockers, ['INVARIANT_MAPPING_MISSING:INV-NO-DUPLICATE-CHARGE']);
});

test('mapping 與 evidence provenance 不一致會被拒絕', () => {
  const result = mapInvariants({
    changedSubjects: ['entity:payment-service'],
    mappings: [mapping({
      evidenceProvenance: { ...provenance, startByte: 20, endByte: 30 },
    })],
    requiredInvariants: ['INV-NO-DUPLICATE-CHARGE'],
  });

  assert.deepEqual(result.blockers, ['INVARIANT_PROVENANCE_MISMATCH:INV-NO-DUPLICATE-CHARGE']);
});
