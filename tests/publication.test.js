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
