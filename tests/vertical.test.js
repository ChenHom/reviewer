import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuthorityState } from '../src/publication.js';
import { runSafetyMvp } from '../src/runner.js';
import { DECISION } from '../src/contracts.js';

async function fixture(name) {
  const source = await readFile(new URL(`../fixtures/safety-mvp/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

async function runFixture(name) {
  const input = await fixture(name);
  const result = runSafetyMvp(input, createAuthorityState(input.identity));
  return { input, result };
}

test('runs the Human Review vertical branch through the production runner', async () => {
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

test('runs the natural NOT_SELECTED branch through the production runner', async () => {
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

test('fails closed when an analysis input is invalid', () => {
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
