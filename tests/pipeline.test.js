import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuthorityState, setCurrentHead } from '../src/publication.js';
import { runSafetyMvp } from '../src/runner.js';
import { deriveCheckState } from '../src/summary.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

const input = {
  identity,
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
};

async function fixture(name) {
  const source = await readFile(new URL(`../fixtures/safety-mvp/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

test('runs analysis, publication, Summary, and status check as one pipeline', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp(input, state);

  assert.equal(result.publication.accepted, true);
  assert.equal(result.summary.published, true);
  assert.deepEqual(result.check, {
    state: 'PASS',
    reason: 'CURRENT_AUTHORITATIVE_SUMMARY',
  });
});

test('does not publish a Summary for a stale candidate', () => {
  const state = createAuthorityState({ ...identity, headSha: 'head-002' });
  const result = runSafetyMvp(input, state);

  assert.deepEqual(result.publication, {
    accepted: false,
    reason: 'STALE_ANALYSIS_IDENTITY',
  });
  assert.equal(result.summary, null);
  assert.deepEqual(result.check, {
    state: 'FAILURE',
    reason: 'STALE_ANALYSIS_IDENTITY',
  });
});

test('keeps analyzer failure on the failing status path', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp({ identity, coverage: { obligations: [] } }, state);

  assert.equal(result.publication.accepted, true);
  assert.equal(result.summary.published, true);
  assert.deepEqual(result.check, {
    state: 'FAILURE',
    reason: 'ANALYSIS_FAILED',
  });
});

test('fails the status check when authoritative Summary publication fails', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp(input, state, { succeed: false });

  assert.equal(result.publication.accepted, true);
  assert.deepEqual(result.summary, {
    published: false,
    reason: 'SUMMARY_PUBLICATION_FAILED',
  });
  assert.deepEqual(result.check, {
    state: 'FAILURE',
    reason: 'SUMMARY_PUBLICATION_FAILED',
  });
});

test('invalidates the old authority as soon as a new head arrives', () => {
  const state = createAuthorityState(identity);
  const oldResult = runSafetyMvp(input, state);
  const nextIdentity = { ...identity, headSha: 'head-002' };

  setCurrentHead(state, nextIdentity);

  assert.equal(oldResult.publication.accepted, true);
  assert.equal(state.current, null);
  assert.deepEqual(
    deriveCheckState({
      candidate: oldResult.candidate,
      summary: oldResult.summary,
      currentIdentity: nextIdentity,
    }),
    { state: 'FAILURE', reason: 'STALE_ANALYSIS_IDENTITY' },
  );
});

test('runs the analysis-failure fixture through the failure check path', async () => {
  const inputFixture = await fixture('analysis-failure');
  const result = runSafetyMvp(inputFixture, createAuthorityState(inputFixture.identity));

  assert.equal(result.publication.accepted, true);
  assert.equal(result.candidate.analysisStatus, inputFixture.expected.analysisStatus);
  assert.equal(result.candidate.decision.status, inputFixture.expected.decisionStatus);
  assert.equal(result.candidate.decision.fallback, inputFixture.expected.fallback);
  assert.equal(result.check.state, inputFixture.expected.checkState);
  assert.equal(result.check.reason, inputFixture.expected.checkReason);
});

test('rejects the stale-run fixture without changing authority', async () => {
  const inputFixture = await fixture('stale-run');
  const state = createAuthorityState(inputFixture.currentIdentity);
  const result = runSafetyMvp(inputFixture.input, state);

  assert.deepEqual(result.publication, {
    accepted: false,
    reason: inputFixture.expected.publicationReason,
  });
  assert.equal(state.current, null);
  assert.deepEqual(result.check, {
    state: inputFixture.expected.checkState,
    reason: inputFixture.expected.checkReason,
  });
});
