import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE, DECISION, ELIGIBILITY } from '../src/contracts.js';
import { evaluateEligibility, reduceReviewScope } from '../src/reducer.js';

const complete = { status: COVERAGE.COMPLETE, blockers: [] };

test('returns ELIGIBLE only when coverage and risk inputs are clear', () => {
  assert.deepEqual(
    evaluateEligibility({ coverage: complete, riskBlockers: [] }),
    { status: ELIGIBILITY.ELIGIBLE, blockingSources: [] },
  );
});

test('preserves coverage blockers as NOT_ELIGIBLE', () => {
  assert.deepEqual(
    evaluateEligibility({
      coverage: { status: COVERAGE.INCOMPLETE, blockers: ['COV-LANG-001:PARTIAL_PARSE'] },
      riskBlockers: [],
    }),
    {
      status: ELIGIBILITY.NOT_ELIGIBLE,
      blockingSources: ['COV-LANG-001:PARTIAL_PARSE'],
    },
  );
});

test('returns ANALYSIS_FAILED for evaluator errors', () => {
  assert.deepEqual(
    evaluateEligibility({
      coverage: { status: COVERAGE.FAILED, blockers: ['ANALYZER_FAILED'] },
      riskBlockers: [],
      analysisError: 'ANALYZER_FAILED',
    }),
    { status: ELIGIBILITY.ANALYSIS_FAILED, blockingSources: ['ANALYZER_FAILED'] },
  );
});

test('cannot reduce a blocked input to NOT_SELECTED', () => {
  const eligibility = {
    status: ELIGIBILITY.NOT_ELIGIBLE,
    blockingSources: ['risk:duplicate-charge'],
  };

  const decision = reduceReviewScope({ eligibility, policyRequirements: [] });

  assert.equal(decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(decision.fallback, 'TARGETED');
  assert.deepEqual(decision.reasons, ['risk:duplicate-charge']);
});

test('uses full fallback for coverage or analysis failures', () => {
  const eligibility = {
    status: ELIGIBILITY.NOT_ELIGIBLE,
    blockingSources: ['COV-LANG-001:PARTIAL_PARSE'],
  };

  assert.deepEqual(
    reduceReviewScope({ eligibility, policyRequirements: [] }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['COV-LANG-001:PARTIAL_PARSE'],
    },
  );
});

test('selects no Human Review only for a clear eligible result', () => {
  assert.deepEqual(
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.ELIGIBLE, blockingSources: [] },
      policyRequirements: [],
    }),
    {
      status: DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW,
      reasons: ['NO_REDUCTION_BLOCKER'],
    },
  );
});

test('adding uncertainty never changes a Human Review result into NOT_SELECTED', () => {
  const decisions = [
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.NOT_ELIGIBLE, blockingSources: ['risk:one'] },
      policyRequirements: [],
    }),
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.NOT_ELIGIBLE, blockingSources: ['risk:one', 'risk:two'] },
      policyRequirements: [],
    }),
  ];

  assert.ok(decisions.every((decision) => decision.status === DECISION.HUMAN_REVIEW_REQUIRED));
});
