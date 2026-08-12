import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE, DECISION, ELIGIBILITY } from '../src/contracts.js';
import { evaluateEligibility, reduceReviewScope } from '../src/reducer.js';

const complete = { status: COVERAGE.COMPLETE, blockers: [] };

test('只有 coverage 與 risk 輸入都清楚時才回傳 ELIGIBLE', () => {
  assert.deepEqual(
    evaluateEligibility({ coverage: complete, riskBlockers: [] }),
    { status: ELIGIBILITY.ELIGIBLE, blockingSources: [] },
  );
});

test('將 coverage blocker 保留為 NOT_ELIGIBLE', () => {
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

test('evaluator 發生錯誤時回傳 ANALYSIS_FAILED', () => {
  assert.deepEqual(
    evaluateEligibility({
      coverage: { status: COVERAGE.FAILED, blockers: ['ANALYZER_FAILED'] },
      riskBlockers: [],
      analysisError: 'ANALYZER_FAILED',
    }),
    { status: ELIGIBILITY.ANALYSIS_FAILED, blockingSources: ['ANALYZER_FAILED'] },
  );
});

test('缺少 coverage 時仍然必須產生 analysis failure blocker', () => {
  assert.deepEqual(
    evaluateEligibility({ coverage: undefined }),
    {
      status: ELIGIBILITY.ANALYSIS_FAILED,
      blockingSources: ['COVERAGE_MISSING'],
    },
  );
});

test('coverage、risk 與 analysis error blocker 會去重並排序', () => {
  assert.deepEqual(
    evaluateEligibility({
      coverage: { status: COVERAGE.INCOMPLETE, blockers: ['coverage:b', 'risk:z'] },
      riskBlockers: ['risk:a', 'coverage:b'],
      analysisError: 'ANALYZER_FAILED',
    }),
    {
      status: ELIGIBILITY.ANALYSIS_FAILED,
      blockingSources: ['ANALYZER_FAILED', 'coverage:b', 'risk:a', 'risk:z'],
    },
  );
});

test('被 blocker 阻擋的輸入不能 reduction 成 NOT_SELECTED', () => {
  const eligibility = {
    status: ELIGIBILITY.NOT_ELIGIBLE,
    blockingSources: ['risk:duplicate-charge'],
  };

  const decision = reduceReviewScope({ eligibility, policyRequirements: [] });

  assert.equal(decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(decision.fallback, 'TARGETED');
  assert.deepEqual(decision.reasons, ['risk:duplicate-charge']);
});

test('coverage 或 analysis failure 使用 FULL fallback', () => {
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

test('只有明確且 eligible 的結果才能選擇不進行 Human Review', () => {
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

test('policy requirement 或 audit sample 會觸發 targeted Human Review', () => {
  assert.deepEqual(
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.ELIGIBLE, blockingSources: [] },
      policyRequirements: ['policy:z', 'policy:a'],
      audit: true,
    }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'TARGETED',
      reasons: ['AUDIT_SAMPLE', 'policy:a', 'policy:z'],
    },
  );
});

test('analysis failure、缺少 eligibility 與未知 eligibility 都採 full review', () => {
  assert.deepEqual(
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.ANALYSIS_FAILED, blockingSources: ['ANALYZER_FAILED'] },
    }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ANALYZER_FAILED'],
    },
  );

  assert.deepEqual(
    reduceReviewScope({ eligibility: undefined }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBILITY_MISSING'],
    },
  );

  assert.deepEqual(
    reduceReviewScope({ eligibility: { status: 'UNKNOWN', blockingSources: [] } }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBILITY_MISSING'],
    },
  );
});

test('不完整 eligibility 不會被 policy requirement 蓋成 NOT_SELECTED', () => {
  const decision = reduceReviewScope({
    eligibility: {
      status: ELIGIBILITY.NOT_ELIGIBLE,
      blockingSources: ['risk:duplicate-charge'],
    },
    policyRequirements: [],
    audit: true,
  });

  assert.equal(decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(decision.fallback, 'TARGETED');
  assert.deepEqual(decision.reasons, ['risk:duplicate-charge']);
});

test('增加不確定性時不能將 Human Review 改成 NOT_SELECTED', () => {
  const blockerPool = [
    'risk:one',
    'risk:two',
    'COV-LANG-001:PARTIAL_PARSE',
    'runtime:unknown',
  ];

  for (let mask = 1; mask < 2 ** blockerPool.length; mask += 1) {
    const blockers = blockerPool.filter((_, index) => (mask & (1 << index)) !== 0);
    const decision = reduceReviewScope({
      eligibility: { status: ELIGIBILITY.NOT_ELIGIBLE, blockingSources: blockers },
      policyRequirements: [],
    });

    assert.equal(decision.status, DECISION.HUMAN_REVIEW_REQUIRED, `blockers=${blockers.join(',')}`);
    assert.deepEqual(decision.reasons, [...blockers].sort(), `blockers=${blockers.join(',')}`);
  }
});

test('eligibility blocker 不一致時採 fail-closed', () => {
  assert.deepEqual(
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.ELIGIBLE, blockingSources: ['risk:unexpected'] },
      policyRequirements: [],
    }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBLE_WITH_BLOCKERS', 'risk:unexpected'],
    },
  );

  assert.deepEqual(
    reduceReviewScope({
      eligibility: { status: ELIGIBILITY.NOT_ELIGIBLE, blockingSources: [] },
      policyRequirements: [],
    }),
    {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBILITY_BLOCKER_MISSING'],
    },
  );
});
