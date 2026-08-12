import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysisInput } from '../src/contracts.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

test('rejects an analysis with no required coverage obligations', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: { obligations: [] },
  });

  assert.deepEqual(result.valid, false);
  assert.ok(result.errors.includes('COVERAGE_NO_REQUIRED_OBLIGATIONS'));
});

test('rejects an eligible result that claims blockers', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: {
      obligations: [{ id: 'COV-1', required: true, status: 'COMPLETE', changedRegions: [] }],
    },
    eligibility: { status: 'ELIGIBLE', blockingSources: ['risk-1'] },
  });

  assert.deepEqual(result.valid, false);
  assert.ok(result.errors.includes('ELIGIBLE_WITH_BLOCKERS'));
});
