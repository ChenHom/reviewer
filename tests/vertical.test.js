import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAnalysis } from '../src/runner.js';
import { DECISION, ELIGIBILITY } from '../src/contracts.js';

async function fixture(name) {
  const source = await readFile(new URL(`../fixtures/safety-mvp/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

test('runs the Human Review vertical branch through the production runner', async () => {
  const result = runAnalysis(await fixture('human-review-required'));

  assert.equal(result.analysisStatus, 'COMPLETE');
  assert.equal(result.eligibility.status, ELIGIBILITY.NOT_ELIGIBLE);
  assert.equal(result.decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(result.decision.fallback, 'TARGETED');
  assert.deepEqual(result.decision.reasons, ['risk:duplicate-charge']);
});

test('runs the natural NOT_SELECTED branch through the production runner', async () => {
  const result = runAnalysis(await fixture('not-selected'));

  assert.equal(result.analysisStatus, 'COMPLETE');
  assert.equal(result.eligibility.status, ELIGIBILITY.ELIGIBLE);
  assert.equal(result.decision.status, DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW);
  assert.deepEqual(result.decision.reasons, ['NO_REDUCTION_BLOCKER']);
});

test('fails closed when an analysis input is invalid', () => {
  const result = runAnalysis({ coverage: { obligations: [] } });

  assert.equal(result.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(result.decision.status, DECISION.HUMAN_REVIEW_REQUIRED);
  assert.equal(result.decision.fallback, 'FULL');
});
