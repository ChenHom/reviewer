import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityState, publishCandidate, setCurrentHead } from '../src/publication.js';
import { runAnalysis } from '../src/runner.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

function inputFor(nextIdentity, overrides = {}) {
  return {
    identity: nextIdentity,
    coverage: {
      obligations: [{
        id: 'COV-LANG-001',
        required: true,
        status: 'COMPLETE',
        changedRegions: [{
          path: 'src/example.js',
          startByte: 0,
          endByte: 1,
          language: 'javascript',
          adapterId: 'javascript-v1',
          runtime: 'server',
        }],
      }],
    },
    riskBlockers: [],
    ...overrides,
  };
}

test('目前 identity 的完整 candidate 可以發布', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis(inputFor(identity));

  const result = publishCandidate(state, candidate);

  assert.equal(result.accepted, true);
  assert.equal(state.current.identity.headSha, 'head-001');
});

test('current head 改變時拒絕 candidate', () => {
  const state = createAuthorityState(identity);
  const oldCandidate = runAnalysis(inputFor(identity));
  const nextIdentity = { ...identity, headSha: 'head-002' };

  setCurrentHead(state, nextIdentity);
  const result = publishCandidate(state, oldCandidate);

  assert.deepEqual(result, { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' });
  assert.equal(state.current, null);
});

test('較晚完成的舊 run 不能取代較新的 authoritative result', () => {
  const state = createAuthorityState(identity);
  const oldCandidate = runAnalysis(inputFor(identity));
  const nextIdentity = { ...identity, headSha: 'head-002' };
  const newCandidate = runAnalysis(inputFor(nextIdentity, { riskBlockers: ['risk:new'] }));

  setCurrentHead(state, nextIdentity);
  assert.equal(publishCandidate(state, newCandidate).accepted, true);
  assert.equal(publishCandidate(state, oldCandidate).accepted, false);
  assert.equal(state.current.identity.headSha, 'head-002');
  assert.deepEqual(state.current.decision.reasons, ['risk:new']);
});

test('policy identity 不同時拒絕 candidate', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis(inputFor({ ...identity, policyVersion: '2' }));

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'STALE_ANALYSIS_IDENTITY',
  });
});

test('runner identity 不同時拒絕 candidate', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis(inputFor({ ...identity, runnerVersion: '2' }));

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'STALE_ANALYSIS_IDENTITY',
  });
});

test('任一 AnalysisIdentity 欄位不同時都視為 stale run', () => {
  const fields = ['repository', 'baseSha', 'headSha', 'policyId', 'policyVersion', 'runnerVersion'];

  for (const field of fields) {
    const state = createAuthorityState(identity);
    const candidate = runAnalysis(inputFor({ ...identity, [field]: `${identity[field]}-next` }));

    assert.deepEqual(
      publishCandidate(state, candidate),
      { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' },
      field,
    );
    assert.equal(state.current, null, field);
  }
});

test('analysis failure 只能以非成功結果發布', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis({ identity, coverage: { obligations: [] } });

  const result = publishCandidate(state, candidate);

  assert.equal(result.accepted, true);
  assert.equal(state.current.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(state.current.decision.fallback, 'FULL');
});

test('拒絕不完整 candidate 且不修改 authority', () => {
  const state = createAuthorityState(identity);

  assert.deepEqual(publishCandidate(state, { identity }), {
    accepted: false,
    reason: 'CANDIDATE_INCOMPLETE',
  });
  assert.equal(state.current, null);
});

test('analysis status 無效時拒絕 candidate', () => {
  const state = createAuthorityState(identity);
  const candidate = {
    identity,
    analysisStatus: 'GARBAGE',
    coverage: { status: 'COMPLETE', blockers: [] },
    eligibility: { status: 'ELIGIBLE', blockingSources: [] },
    decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['NO_REDUCTION_BLOCKER'] },
  };

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'CANDIDATE_INVALID',
  });
  assert.equal(state.current, null);
});

test('ELIGIBLE candidate 含有 blocker 時拒絕發布', () => {
  const state = createAuthorityState(identity);
  const candidate = {
    identity,
    analysisStatus: 'COMPLETE',
    coverage: { status: 'COMPLETE', blockers: [] },
    eligibility: { status: 'ELIGIBLE', blockingSources: ['risk:unexpected'] },
    decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['NO_REDUCTION_BLOCKER'] },
  };

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'CANDIDATE_INVALID',
  });
});

test('COMPLETE candidate 含有 coverage blocker 時拒絕發布', () => {
  const state = createAuthorityState(identity);
  const candidate = {
    identity,
    analysisStatus: 'COMPLETE',
    coverage: { status: 'COMPLETE', blockers: ['COV-LANG-001:PARTIAL_PARSE'] },
    eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['COV-LANG-001:PARTIAL_PARSE'] },
    decision: {
      status: 'HUMAN_REVIEW_REQUIRED',
      fallback: 'FULL',
      reasons: ['COV-LANG-001:PARTIAL_PARSE'],
    },
  };

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'CANDIDATE_INVALID',
  });
});

test('跨欄位矛盾的 candidate 一律不能成為 authoritative result', () => {
  const cases = [
    {
      name: 'NOT_SELECTED 缺少 ELIGIBLE',
      candidate: {
        identity,
        analysisStatus: 'COMPLETE',
        coverage: { status: 'COMPLETE', blockers: [] },
        eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['risk:one'] },
        decision: { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['risk:one'] },
      },
    },
    {
      name: 'NOT_SELECTED 帶有 fallback',
      candidate: {
        identity,
        analysisStatus: 'COMPLETE',
        coverage: { status: 'COMPLETE', blockers: [] },
        eligibility: { status: 'ELIGIBLE', blockingSources: [] },
        decision: {
          status: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
          fallback: 'TARGETED',
          reasons: ['NO_REDUCTION_BLOCKER'],
        },
      },
    },
    {
      name: 'analysis failure 使用 targeted fallback',
      candidate: {
        identity,
        analysisStatus: 'ANALYSIS_FAILED',
        coverage: { status: 'FAILED', blockers: ['ANALYZER_FAILED'] },
        eligibility: { status: 'ANALYSIS_FAILED', blockingSources: ['ANALYZER_FAILED'] },
        decision: {
          status: 'HUMAN_REVIEW_REQUIRED',
          fallback: 'TARGETED',
          reasons: ['ANALYZER_FAILED'],
        },
      },
    },
    {
      name: 'Human Review 使用未知 fallback',
      candidate: {
        identity,
        analysisStatus: 'COMPLETE',
        coverage: { status: 'INCOMPLETE', blockers: ['COV-1:TIMEOUT'] },
        eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['COV-1:TIMEOUT'] },
        decision: {
          status: 'HUMAN_REVIEW_REQUIRED',
          fallback: 'NONE',
          reasons: ['COV-1:TIMEOUT'],
        },
      },
    },
  ];

  for (const testCase of cases) {
    const state = createAuthorityState(identity);

    assert.deepEqual(
      publishCandidate(state, testCase.candidate),
      { accepted: false, reason: 'CANDIDATE_INVALID' },
      testCase.name,
    );
    assert.equal(state.current, null, testCase.name);
  }
});

test('拒絕 invalid candidate 時不會覆蓋既有 authoritative result', () => {
  const state = createAuthorityState(identity);
  const validCandidate = runAnalysis(inputFor(identity));
  assert.equal(publishCandidate(state, validCandidate).accepted, true);

  const invalidCandidate = {
    ...validCandidate,
    analysisStatus: 'GARBAGE',
  };
  assert.deepEqual(publishCandidate(state, invalidCandidate), {
    accepted: false,
    reason: 'CANDIDATE_INVALID',
  });
  assert.equal(state.current.analysisStatus, 'COMPLETE');
});
