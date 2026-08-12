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

test('只有 authoritative result 與 Summary 共用 identity 時才通過', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current));

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' },
  );
});

test('Summary 發布失敗時回傳 FAILURE', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current), { succeed: false });

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_PUBLICATION_FAILED' },
  );
});

test('缺少 Summary 時回傳 FAILURE', () => {
  const current = authoritative(candidateFor());

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary: null, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_MISSING' },
  );
});

test('Summary identity 與 current head 不一致時回傳 FAILURE', () => {
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

test('analysis failure 不能通過 status check', () => {
  const current = authoritative(runAnalysis({ identity, coverage: { obligations: [] } }));
  const summary = publishSummary(buildSummary(current));

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'ANALYSIS_FAILED' },
  );
});

test('Summary 內容與 authoritative candidate 不一致時回傳 FAILURE', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary({
    identity,
    candidateDigest: 'wrong-digest',
    analysisStatus: 'COMPLETE',
    coverage: { status: 'FAILED', blockers: ['tampered'] },
    eligibility: { status: 'ANALYSIS_FAILED', blockingSources: ['tampered'] },
    decision: { status: 'HUMAN_REVIEW_REQUIRED', fallback: 'FULL', reasons: ['tampered'] },
  });

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_CANDIDATE_MISMATCH' },
  );
});

test('Summary 發布後內容被修改時回傳 FAILURE', () => {
  const current = authoritative(candidateFor());
  const summary = publishSummary(buildSummary(current));
  summary.summary.coverage = { status: 'FAILED', blockers: ['tampered'] };

  assert.deepEqual(
    deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'SUMMARY_CANDIDATE_MISMATCH' },
  );
});
