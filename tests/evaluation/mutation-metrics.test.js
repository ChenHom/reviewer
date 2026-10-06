import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateMutationMetrics,
  validateMutationEvaluation,
} from '../../evaluation/mutations/metrics.js';

function result(overrides = {}) {
  return {
    id: 'CASE-001',
    classification: 'critical',
    publicationAccepted: true,
    analysisStatus: 'COMPLETE',
    coverageStatus: 'COMPLETE',
    decisionStatus: 'HUMAN_REVIEW_REQUIRED',
    fallback: 'TARGETED',
    factKinds: ['KNOWN_FACT'],
    expectedFactKinds: ['KNOWN_FACT'],
    expectedCurrentDecision: 'HUMAN_REVIEW_REQUIRED',
    ...overrides,
  };
}

test('mutation metrics 會分開計算 critical recall 與 direct fact coverage', () => {
  const metrics = calculateMutationMetrics([
    result({ id: 'critical-direct' }),
    result({
      id: 'critical-fallback',
      coverageStatus: 'INCOMPLETE',
      fallback: 'FULL',
      factKinds: [],
      expectedFactKinds: [],
    }),
    result({
      id: 'safe-reduced',
      classification: 'safe',
      decisionStatus: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
      fallback: null,
      factKinds: [],
      expectedFactKinds: [],
      expectedCurrentDecision: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
    }),
    result({
      id: 'safe-held',
      classification: 'safe',
      coverageStatus: 'INCOMPLETE',
      fallback: 'FULL',
      factKinds: [],
      expectedFactKinds: [],
    }),
  ]);

  assert.equal(metrics.criticalRecall, 1);
  assert.equal(metrics.falseNegativeRate, 0);
  assert.equal(metrics.criticalDirectFactCoverage, 0.5);
  assert.equal(metrics.criticalFallbackOnlyCount, 1);
  assert.equal(metrics.safeReductionRate, 0.5);
  assert.equal(metrics.partialCoverageRate, 0.5);
  assert.equal(metrics.fullReviewFallbackRate, 0.5);
});

test('critical mutation 被 NOT_SELECTED 時 evaluation gate 必須失敗', () => {
  const failures = validateMutationEvaluation([
    result({
      decisionStatus: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
      expectedCurrentDecision: 'HUMAN_REVIEW_REQUIRED',
    }),
  ]);

  assert.deepEqual(failures, [
    'CRITICAL_FALSE_NEGATIVE:CASE-001',
    'DECISION_REGRESSION:CASE-001',
  ]);
});

test('預期 semantic fact 消失時 evaluation gate 必須失敗', () => {
  const failures = validateMutationEvaluation([
    result({ factKinds: [] }),
  ]);

  assert.deepEqual(failures, ['EXPECTED_FACT_MISSING:CASE-001:KNOWN_FACT']);
});
