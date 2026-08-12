import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummary,
  candidateDigest,
  deriveCheckState,
  publishSummary,
} from '../src/summary.js';
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

test('Summary payload 不完整時拒絕發布', () => {
  assert.deepEqual(publishSummary(), {
    published: false,
    reason: 'SUMMARY_INVALID',
  });
  assert.deepEqual(publishSummary({ identity }), {
    published: false,
    reason: 'SUMMARY_INVALID',
  });
  assert.deepEqual(publishSummary({ identity, candidateDigest: 123 }), {
    published: false,
    reason: 'SUMMARY_INVALID',
  });
});

test('非 authoritative candidate 不能通過 status check', () => {
  const candidate = candidateFor();
  const summary = publishSummary(buildSummary(candidate));

  assert.deepEqual(
    deriveCheckState({ candidate, summary, currentIdentity: identity }),
    { state: 'FAILURE', reason: 'CANDIDATE_NOT_AUTHORITATIVE' },
  );
});

test('invalid candidate 與不完整 Summary 都採 failure 且不拋例外', () => {
  const current = authoritative(candidateFor());
  const invalidCandidate = { ...current, analysisStatus: 'GARBAGE' };

  assert.deepEqual(
    deriveCheckState({
      candidate: invalidCandidate,
      summary: publishSummary(buildSummary(current)),
      currentIdentity: identity,
    }),
    { state: 'FAILURE', reason: 'CANDIDATE_INVALID' },
  );

  assert.deepEqual(
    deriveCheckState({
      candidate: current,
      summary: { published: true, identity, summary: null },
      currentIdentity: identity,
    }),
    { state: 'FAILURE', reason: 'SUMMARY_CANDIDATE_MISMATCH' },
  );
});

test('candidate digest 對 object key 順序不敏感，但保留內容差異', () => {
  const candidate = candidateFor();
  const reordered = {
    decision: candidate.decision,
    eligibility: candidate.eligibility,
    coverage: candidate.coverage,
    analysisStatus: candidate.analysisStatus,
    identity: {
      runnerVersion: candidate.identity.runnerVersion,
      policyVersion: candidate.identity.policyVersion,
      policyId: candidate.identity.policyId,
      headSha: candidate.identity.headSha,
      baseSha: candidate.identity.baseSha,
      repository: candidate.identity.repository,
    },
  };

  assert.equal(candidateDigest(candidate), candidateDigest(reordered));
  assert.notEqual(
    candidateDigest(candidate),
    candidateDigest({ ...candidate, analysisStatus: 'ANALYSIS_FAILED' }),
  );
});

test('Summary 的每個核心欄位被竄改時都會被 digest 偵測', () => {
  const current = authoritative(candidateFor());
  const published = publishSummary(buildSummary(current));
  const mutations = {
    analysisStatus: 'ANALYSIS_FAILED',
    coverage: { status: 'INCOMPLETE', blockers: ['tampered:coverage'] },
    eligibility: { status: 'NOT_ELIGIBLE', blockingSources: ['tampered:eligibility'] },
    decision: {
      status: 'HUMAN_REVIEW_REQUIRED',
      fallback: 'FULL',
      reasons: ['tampered:decision'],
    },
  };

  for (const [field, value] of Object.entries(mutations)) {
    const summary = {
      ...published,
      summary: { ...published.summary, [field]: value },
    };

    assert.deepEqual(
      deriveCheckState({ candidate: current, summary, currentIdentity: identity }),
      { state: 'FAILURE', reason: 'SUMMARY_CANDIDATE_MISMATCH' },
      field,
    );
  }
});
