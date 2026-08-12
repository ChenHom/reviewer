import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuthorityState } from '../src/publication.js';
import { runSafetyMvp } from '../src/runner.js';
import { DECISION } from '../src/contracts.js';
import { createAnalysisContextBinding, validateAdapterResult } from '../src/adapters/contracts.js';

async function fixture(name) {
  const source = await readFile(new URL(`../fixtures/safety-mvp/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

async function runFixture(name) {
  const input = await fixture(name);
  const contextBinding = createAnalysisContextBinding(input.adapterResult);
  const result = runSafetyMvp(
    { ...input, contextBinding },
    createAuthorityState(input.identity, contextBinding),
  );
  return { input, result };
}

test('所有 Safety MVP fixtures 都攜帶可驗證的 AdapterSet 與 region runtime context', async () => {
  const fixtureNames = [
    'analysis-failure',
    'coverage-timeout',
    'coverage-truncated',
    'coverage-unsupported',
    'human-review-required',
    'not-selected',
    'stale-run',
  ];

  for (const fixtureName of fixtureNames) {
    const input = await fixture(fixtureName);
    const adapterResult = fixtureName === 'stale-run' ? input.input.adapterResult : input.adapterResult;
    assert.deepEqual(
      validateAdapterResult(adapterResult),
      { valid: true, errors: [] },
      fixtureName,
    );
  }
});

test('Human Review vertical branch 透過 production runner 執行', async () => {
  const { input, result } = await runFixture('human-review-required');
  const expected = input.expected;

  assert.equal(result.candidate.analysisStatus, expected.analysisStatus);
  assert.equal(result.candidate.eligibility.status, expected.eligibilityStatus);
  assert.equal(result.candidate.decision.status, expected.decisionStatus);
  assert.equal(result.candidate.decision.fallback, expected.fallback);
  assert.deepEqual(result.candidate.decision.reasons, expected.reasons);
  assert.equal(result.candidate.identity.headSha, expected.headSha);
  assert.equal(result.summary.summary.identity.headSha, expected.headSha);
  assert.equal(result.check.state, 'PASS');
});

test('自然 NOT_SELECTED branch 透過 production runner 執行', async () => {
  const { input, result } = await runFixture('not-selected');
  const expected = input.expected;

  assert.equal(result.candidate.analysisStatus, expected.analysisStatus);
  assert.equal(result.candidate.eligibility.status, expected.eligibilityStatus);
  assert.equal(result.candidate.decision.status, expected.decisionStatus);
  assert.equal(result.candidate.decision.fallback ?? null, expected.fallback);
  assert.deepEqual(result.candidate.decision.reasons, expected.reasons);
  assert.equal(result.candidate.identity.headSha, expected.headSha);
  assert.equal(result.summary.summary.identity.headSha, expected.headSha);
  assert.equal(result.check.state, 'PASS');
});

test('analysis 輸入無效時採 fail-closed', () => {
  const identity = {
    repository: 'example/repo',
    baseSha: 'base-001',
    headSha: 'head-invalid-001',
    policyId: 'policy-001',
    policyVersion: '1',
    runnerVersion: '1',
  };
  const result = runSafetyMvp(
    { identity, coverage: { obligations: [] } },
    createAuthorityState(identity),
  );

  assert.equal(result.candidate.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(result.candidate.decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(result.candidate.decision.fallback, 'FULL');
  assert.equal(result.check.state, 'FAILURE');
  assert.equal(result.check.reason, 'ANALYSIS_FAILED');
});

for (const fixtureName of ['coverage-timeout', 'coverage-unsupported', 'coverage-truncated']) {
  test(`${fixtureName} fixture 不能被 reduction 成 NOT_SELECTED`, async () => {
    const { input, result } = await runFixture(fixtureName);
    const expected = input.expected;

    assert.equal(result.candidate.analysisStatus, expected.analysisStatus);
    assert.equal(result.candidate.coverage.status, 'INCOMPLETE');
    assert.equal(result.candidate.eligibility.status, expected.eligibilityStatus);
    assert.equal(result.candidate.decision.status, expected.decisionStatus);
    assert.equal(result.candidate.decision.fallback, expected.fallback);
    assert.deepEqual(result.candidate.decision.reasons, expected.reasons);
    assert.equal(result.candidate.identity.headSha, expected.headSha);
    assert.equal(result.summary.summary.identity.headSha, expected.headSha);
    assert.deepEqual(result.check, {
      state: expected.checkState,
      reason: expected.checkReason,
    });
  });
}
