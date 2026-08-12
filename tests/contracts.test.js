import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysisInput, validateCandidate } from '../src/contracts.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

const completeCoverage = {
  obligations: [{
    id: 'COV-1',
    required: true,
    status: 'COMPLETE',
    changedRegions: [],
  }],
};

test('拒絕沒有必要 coverage obligation 的分析', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: { obligations: [] },
  });

  assert.deepEqual(result.valid, false);
  assert.ok(result.errors.includes('COVERAGE_NO_REQUIRED_OBLIGATIONS'));
});

test('缺少整個 analysis input 時同時回報 identity 與 coverage 缺失', () => {
  const result = validateAnalysisInput();

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('IDENTITY_MISSING'));
  assert.ok(result.errors.includes('COVERAGE_MISSING'));
});

test('拒絕宣稱有 blocker 的 ELIGIBLE 結果', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: {
      obligations: [{ id: 'COV-1', required: true, status: 'COMPLETE', changedRegions: [] }],
    },
    eligibility: { status: 'ELIGIBLE', blockingSources: ['risk-1'] },
  });

  assert.deepEqual(result.valid, false);
  assert.ok(result.errors.includes('ELIGIBLE_WITH_BLOCKERS'));
});

test('拒絕不一致的 risk、policy 與 eligibility 輸入', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: {
      obligations: [{
        id: 'COV-1',
        required: true,
        status: 'COMPLETE',
        changedRegions: [],
      }],
    },
    riskBlockers: 'risk-1',
    policyRequirements: [null],
    audit: 'yes',
    eligibility: { status: 'UNKNOWN', blockingSources: [] },
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('RISK_BLOCKERS_INVALID'));
  assert.ok(result.errors.includes('POLICY_REQUIREMENTS_INVALID'));
  assert.ok(result.errors.includes('AUDIT_INVALID'));
  assert.ok(result.errors.includes('ELIGIBILITY_STATUS_INVALID'));
});

test('逐一拒絕缺少的 AnalysisIdentity 欄位', () => {
  const fields = ['repository', 'baseSha', 'headSha', 'policyId', 'policyVersion', 'runnerVersion'];

  for (const field of fields) {
    const result = validateAnalysisInput({
      identity: { ...identity, [field]: '' },
      coverage: completeCoverage,
    });

    assert.equal(result.valid, false, field);
    assert.ok(result.errors.includes(`IDENTITY_${field.toUpperCase()}_MISSING`), field);
  }
});

test('拒絕缺少或重複的 coverage obligation identity', () => {
  const cases = [
    {
      name: '缺少 obligation id',
      coverage: {
        obligations: [{ ...completeCoverage.obligations[0], id: '' }],
      },
      error: 'COVERAGE_ID_MISSING',
    },
    {
      name: '重複 obligation id',
      coverage: {
        obligations: [completeCoverage.obligations[0], { ...completeCoverage.obligations[0] }],
      },
      error: 'COVERAGE_DUPLICATE_OBLIGATION',
    },
    {
      name: '未知 obligation status',
      coverage: {
        obligations: [{ ...completeCoverage.obligations[0], status: 'UNKNOWN' }],
      },
      error: 'COVERAGE_STATUS_INVALID:COV-1',
    },
  ];

  for (const testCase of cases) {
    const result = validateAnalysisInput({ identity, coverage: testCase.coverage });

    assert.equal(result.valid, false, testCase.name);
    assert.ok(result.errors.includes(testCase.error), testCase.name);
  }
});

test('拒絕無效或沒有 blocker 的 eligibility 結果', () => {
  const cases = [
    { status: 'NOT_ELIGIBLE', blockingSources: [] },
    { status: 'ANALYSIS_FAILED', blockingSources: [] },
    { status: 'ELIGIBLE', blockingSources: [1] },
  ];

  for (const eligibility of cases) {
    const result = validateAnalysisInput({ identity, coverage: completeCoverage, eligibility });

    assert.equal(result.valid, false, eligibility.status);
    assert.ok(result.errors.length > 0, eligibility.status);
  }
});

test('拒絕空白的 analysis error 與非字串設定欄位', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: completeCoverage,
    analysisError: ' ',
    riskBlockers: ['risk-1', ''],
    policyRequirements: ['policy-1', null],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('ANALYSIS_ERROR_INVALID'));
  assert.ok(result.errors.includes('RISK_BLOCKERS_INVALID'));
  assert.ok(result.errors.includes('POLICY_REQUIREMENTS_INVALID'));
});

test('candidate 的 status、fallback 與跨欄位一致性必須同時成立', () => {
  const baseCandidate = {
    identity,
    analysisStatus: 'COMPLETE',
    coverage: { status: 'COMPLETE', blockers: [] },
    eligibility: { status: 'ELIGIBLE', blockingSources: [] },
    decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['NO_REDUCTION_BLOCKER'] },
  };

  const cases = [
    {
      name: 'NOT_SELECTED 不得攜帶 fallback',
      candidate: {
        ...baseCandidate,
        decision: {
          ...baseCandidate.decision,
          fallback: 'TARGETED',
        },
      },
      error: 'NOT_SELECTED_WITH_FALLBACK',
    },
    {
      name: 'NOT_ELIGIBLE 必須要求 Human Review',
      candidate: {
        ...baseCandidate,
        eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['risk-1'] },
        decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['risk-1'] },
      },
      error: 'NOT_ELIGIBLE_WITHOUT_HUMAN_REVIEW',
    },
    {
      name: 'analysis failure 必須 full review',
      candidate: {
        ...baseCandidate,
        analysisStatus: 'ANALYSIS_FAILED',
        coverage: { status: 'FAILED', blockers: ['COVERAGE_MISSING'] },
        eligibility: { status: 'ANALYSIS_FAILED', blockingSources: ['ANALYZER_FAILED'] },
        decision: {
          status: 'HUMAN_REVIEW_REQUIRED',
          fallback: 'TARGETED',
          reasons: ['ANALYZER_FAILED'],
        },
      },
      error: 'ANALYSIS_FAILED_DECISION_MISMATCH',
    },
    {
      name: 'COMPLETE 不得搭配 analysis failure',
      candidate: {
        ...baseCandidate,
        eligibility: { status: 'ANALYSIS_FAILED', blockingSources: ['ANALYZER_FAILED'] },
      },
      error: 'COMPLETE_WITH_ANALYSIS_FAILURE',
    },
    {
      name: 'coverage failure 不得假裝分析完成',
      candidate: {
        ...baseCandidate,
        coverage: { status: 'FAILED', blockers: ['COVERAGE_MISSING'] },
      },
      error: 'COVERAGE_FAILED_WITHOUT_ANALYSIS_FAILURE',
    },
    {
      name: 'ELIGIBLE 不得搭配不完整 coverage',
      candidate: {
        ...baseCandidate,
        coverage: { status: 'INCOMPLETE', blockers: ['COV-1:PARTIAL_PARSE'] },
      },
      error: 'ELIGIBLE_WITH_INCOMPLETE_COVERAGE',
    },
  ];

  for (const testCase of cases) {
    const result = validateCandidate(testCase.candidate);

    assert.equal(result.valid, false, testCase.name);
    assert.ok(result.errors.includes(testCase.error), testCase.name);
  }
});

test('candidate 的必要區塊、blocker 與 decision reasons 不得缺失或錯型別', () => {
  const baseCandidate = {
    identity,
    analysisStatus: 'COMPLETE',
    coverage: { status: 'COMPLETE', blockers: [] },
    eligibility: { status: 'ELIGIBLE', blockingSources: [] },
    decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['NO_REDUCTION_BLOCKER'] },
  };
  const cases = [
    {
      name: '缺少 coverage',
      candidate: { ...baseCandidate, coverage: undefined },
      error: 'CANDIDATE_COVERAGE_INVALID',
    },
    {
      name: 'coverage blocker 非陣列',
      candidate: { ...baseCandidate, coverage: { status: 'INCOMPLETE', blockers: 'COV-1' } },
      error: 'CANDIDATE_COVERAGE_BLOCKERS_INVALID',
    },
    {
      name: 'INCOMPLETE coverage 沒有 blocker',
      candidate: { ...baseCandidate, coverage: { status: 'INCOMPLETE', blockers: [] } },
      error: 'INCOMPLETE_WITHOUT_COVERAGE_BLOCKERS',
    },
    {
      name: '缺少 eligibility',
      candidate: { ...baseCandidate, eligibility: undefined },
      error: 'CANDIDATE_ELIGIBILITY_INVALID',
    },
    {
      name: 'eligibility blocker 非陣列',
      candidate: {
        ...baseCandidate,
        eligibility: { status: 'NOT_ELIGIBLE', blockingSources: 'risk-1' },
      },
      error: 'CANDIDATE_ELIGIBILITY_BLOCKERS_INVALID',
    },
    {
      name: '缺少 decision reasons',
      candidate: {
        ...baseCandidate,
        decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: [] },
      },
      error: 'CANDIDATE_DECISION_INVALID',
    },
    {
      name: 'analysis failure eligibility 不一致',
      candidate: {
        ...baseCandidate,
        analysisStatus: 'ANALYSIS_FAILED',
        coverage: { status: 'FAILED', blockers: ['ANALYZER_FAILED'] },
        eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['ANALYZER_FAILED'] },
        decision: {
          status: 'HUMAN_REVIEW_REQUIRED',
          fallback: 'FULL',
          reasons: ['ANALYZER_FAILED'],
        },
      },
      error: 'ANALYSIS_FAILED_ELIGIBILITY_MISMATCH',
    },
  ];

  for (const testCase of cases) {
    const result = validateCandidate(testCase.candidate);

    assert.equal(result.valid, false, testCase.name);
    assert.ok(result.errors.includes(testCase.error), testCase.name);
  }
});
