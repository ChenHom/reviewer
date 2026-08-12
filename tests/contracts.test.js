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

test('拒絕沒有必要 coverage obligation 的分析', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: { obligations: [] },
  });

  assert.deepEqual(result.valid, false);
  assert.ok(result.errors.includes('COVERAGE_NO_REQUIRED_OBLIGATIONS'));
});

test('拒絕宣稱有 blocker 的 ELIGIBLE 結果', () => {
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

test('拒絕不一致的 risk、policy 與 eligibility 輸入', () => {
  const result = validateAnalysisInput({
    identity,
    coverage: {
      obligations: [{
        id: 'COV-1',
        required: true,
        status: 'COMPLETE',
        changedRegions: [],
      }],
    },
    riskBlockers: 'risk-1',
    policyRequirements: [null],
    audit: 'yes',
    eligibility: { status: 'UNKNOWN', blockingSources: [] },
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('RISK_BLOCKERS_INVALID'));
  assert.ok(result.errors.includes('POLICY_REQUIREMENTS_INVALID'));
  assert.ok(result.errors.includes('AUDIT_INVALID'));
  assert.ok(result.errors.includes('ELIGIBILITY_STATUS_INVALID'));
});
