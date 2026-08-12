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

test('publishes a complete candidate for the current identity', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis(inputFor(identity));

  const result = publishCandidate(state, candidate);

  assert.equal(result.accepted, true);
  assert.equal(state.current.identity.headSha, 'head-001');
});

test('rejects a candidate when the current head changed', () => {
  const state = createAuthorityState(identity);
  const oldCandidate = runAnalysis(inputFor(identity));
  const nextIdentity = { ...identity, headSha: 'head-002' };

  setCurrentHead(state, nextIdentity);
  const result = publishCandidate(state, oldCandidate);

  assert.deepEqual(result, { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' });
  assert.equal(state.current, null);
});

test('a late old run cannot replace the newer authoritative result', () => {
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

test('rejects a candidate with a different policy identity', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis(inputFor({ ...identity, policyVersion: '2' }));

  assert.deepEqual(publishCandidate(state, candidate), {
    accepted: false,
    reason: 'STALE_ANALYSIS_IDENTITY',
  });
});

test('publishes analysis failure only as a non-success result', () => {
  const state = createAuthorityState(identity);
  const candidate = runAnalysis({ identity, coverage: { obligations: [] } });

  const result = publishCandidate(state, candidate);

  assert.equal(result.accepted, true);
  assert.equal(state.current.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(state.current.decision.fallback, 'FULL');
});

test('rejects an incomplete candidate without mutating authority', () => {
  const state = createAuthorityState(identity);

  assert.deepEqual(publishCandidate(state, { identity }), {
    accepted: false,
    reason: 'CANDIDATE_INCOMPLETE',
  });
  assert.equal(state.current, null);
});
