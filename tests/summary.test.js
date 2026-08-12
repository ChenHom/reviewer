import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, deriveCheckState, publishSummary } from '../src/summary.js';
import { createAuthorityState, publishCandidate } from '../src/publication.js';
import { runAnalysis } from '../src/runner.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

function candidateFor(nextIdentity = identity, overrides = {}) {
  return runAnalysis({
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
    ...overrides,
  });
}

function authoritative(candidate) {
  const state = createAuthorityState(identity);
  publishCandidate(state, candidate);
  return state.current;
}

test('passes only when authoritative result and Summary share identity', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current));

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' },
  );
});

test('fails when Summary publication fails', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current), { succeed: false });

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_PUBLICATION_FAILED' },
  );
});

test('fails when Summary is missing', () => {
  const current = authoritative(candidateFor());

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary: null, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_MISSING' },
  );
});

test('fails when Summary identity does not match current head', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current));

  assert.deepEqual(
    deriveCheckState({
      candidate: current,
      summary,
      currentIdentity: { ...identity, headSha: 'head-002' },
    }),
    { state: 'FAILURE', reason: 'STALE_ANALYSIS_IDENTITY' },
  );
});

test('does not pass an analysis failure', () => {
  const current = authoritative(runAnalysis({ identity, coverage: { obligations: [] } }));
  const summary = publishSummary(buildSummary(current));

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'ANALYSIS_FAILED' },
  );
});
