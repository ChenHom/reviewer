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

test('以單一 pipeline 串接 analysis、publication、Summary 與 status check', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp(input, state);

  assert.equal(result.publication.accepted, true);
  assert.equal(result.summary.published, true);
  assert.deepEqual(result.check, {
    state: 'PASS',
    reason: 'CURRENT_AUTHORITATIVE_SUMMARY',
  });
});

test('stale candidate 不發布 Summary', () => {
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

test('analyzer failure 維持在失敗 status path', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp({ identity, coverage: { obligations: [] } }, state);

  assert.equal(result.publication.accepted, true);
  assert.equal(result.summary.published, true);
  assert.deepEqual(result.check, {
    state: 'FAILURE',
    reason: 'ANALYSIS_FAILED',
  });
});

test('authoritative Summary 發布失敗時 status check 回傳 FAILURE', () => {
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

test('新 head 到達時立即使舊 authority 失效', () => {
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

test('analysis-failure fixture 走 failure check path', async () => {
  const inputFixture = await fixture('analysis-failure');
  const result = runSafetyMvp(inputFixture, createAuthorityState(inputFixture.identity));

  assert.equal(result.publication.accepted, true);
  assert.equal(result.candidate.analysisStatus, inputFixture.expected.analysisStatus);
  assert.equal(result.candidate.decision.status, inputFixture.expected.decisionStatus);
  assert.equal(result.candidate.decision.fallback, inputFixture.expected.fallback);
  assert.equal(result.check.state, inputFixture.expected.checkState);
  assert.equal(result.check.reason, inputFixture.expected.checkReason);
});

test('拒絕 stale-run fixture 且不修改 authority', async () => {
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
