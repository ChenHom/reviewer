import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuthorityState, setCurrentHead } from '../src/publication.js';
import { runSafetyMvp } from '../src/runner.js';
import { deriveCheckState } from '../src/summary.js';
import { createAnalysisContextBinding } from '../src/adapters/contracts.js';

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

test('有效 context binding 必須從 input 綁定到 candidate 與 Summary', () => {
  const contextBinding = createAnalysisContextBinding({
    adapterSet: [{
      id: 'javascript-v1',
      version: '1',
      languages: ['javascript'],
      capabilities: ['changed-regions', 'runtime-context'],
    }],
    obligations: [{
      id: 'COV-1',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{
        path: 'src/example.js', startByte: 0, endByte: 1, language: 'javascript', adapterId: 'javascript-v1',
        runtimeContext: { namespace: 'server', id: 'server:api', source: 'adapter', version: 'node-24' },
      }],
    }],
    diagnostics: [],
    evidenceReferences: [],
    complete: true,
  });
  const state = createAuthorityState(identity, contextBinding);
  const result = runSafetyMvp({ ...input, contextBinding }, state);

  assert.deepEqual(result.candidate.contextBinding, contextBinding);
  assert.deepEqual(result.summary.summary.contextBinding, contextBinding);
  assert.equal(result.check.state, 'PASS');
});

test('預設 authority 必須使用 input context binding', () => {
  const contextBinding = createAnalysisContextBinding({
    adapterSet: [{
      id: 'javascript-v1',
      version: '1',
      languages: ['javascript'],
      capabilities: ['changed-regions', 'runtime-context'],
    }],
    obligations: [{
      id: 'COV-1',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{
        path: 'src/example.js', startByte: 0, endByte: 1, language: 'javascript', adapterId: 'javascript-v1',
        runtimeContext: { namespace: 'server', id: 'server:api', source: 'adapter', version: 'node-24' },
      }],
    }],
    diagnostics: [],
    evidenceReferences: [],
    complete: true,
  });

  const result = runSafetyMvp({ ...input, contextBinding });

  assert.equal(result.publication.accepted, true);
  assert.equal(result.check.state, 'PASS');
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

test('合法輸入但 analyzer error 仍然維持 ANALYSIS_FAILED', () => {
  const state = createAuthorityState(identity);
  const result = runSafetyMvp({ ...input, analysisError: 'ANALYZER_FAILED' }, state);

  assert.equal(result.publication.accepted, true);
  assert.equal(result.candidate.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(result.candidate.eligibility.status, 'ANALYSIS_FAILED');
  assert.deepEqual(result.candidate.decision, {
    status: 'HUMAN_REVIEW_REQUIRED',
    fallback: 'FULL',
    reasons: ['ANALYZER_FAILED'],
  });
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
  const contextBinding = createAnalysisContextBinding(inputFixture.adapterResult);
  const result = runSafetyMvp(
    { ...inputFixture, contextBinding },
    createAuthorityState(inputFixture.identity, contextBinding),
  );

  assert.equal(result.publication.accepted, true);
  assert.equal(result.candidate.analysisStatus, inputFixture.expected.analysisStatus);
  assert.equal(result.candidate.decision.status, inputFixture.expected.decisionStatus);
  assert.equal(result.candidate.decision.fallback, inputFixture.expected.fallback);
  assert.equal(result.check.state, inputFixture.expected.checkState);
  assert.equal(result.check.reason, inputFixture.expected.checkReason);
});

test('拒絕 stale-run fixture 且不修改 authority', async () => {
  const inputFixture = await fixture('stale-run');
  const contextBinding = createAnalysisContextBinding(inputFixture.input.adapterResult);
  const state = createAuthorityState(inputFixture.currentIdentity, contextBinding);
  const result = runSafetyMvp({ ...inputFixture.input, contextBinding }, state);

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
