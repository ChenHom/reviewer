import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../../src/summary.js';
import { runAnalysis } from '../../src/runner.js';
import { validateGithubPayload } from '../../src/integrations/github/contracts.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-github-contract-001',
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
        endByte: 10,
        language: 'javascript',
        adapterId: 'javascript-v1',
        runtime: 'server',
      }],
    }],
  },
  riskBlockers: [],
};

const summary = buildSummary(runAnalysis(input));

function payload(overrides = {}) {
  return {
    repository: identity.repository,
    headSha: identity.headSha,
    candidateDigest: summary.candidateDigest,
    summary,
    check: { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' },
    ...overrides,
  };
}

function errorsOf(value) {
  return validateGithubPayload(value).errors;
}

test('完整綁定的 payload 通過驗證', () => {
  assert.deepEqual(validateGithubPayload(payload()), { valid: true, errors: [] });
});

test('undefined payload 回報所有必要欄位缺失，且 errors 為穩定排序', () => {
  const result = validateGithubPayload(undefined);

  assert.equal(result.valid, false);
  for (const code of [
    'GITHUB_REPOSITORY_MISSING',
    'GITHUB_HEAD_SHA_MISSING',
    'GITHUB_CANDIDATE_DIGEST_MISSING',
    'GITHUB_SUMMARY_MISSING',
    'GITHUB_SUMMARY_BINDING_MISSING',
    'GITHUB_IDENTITY_MISMATCH',
    'GITHUB_CHECK_STATE_INVALID',
    'GITHUB_CHECK_REASON_INVALID',
  ]) {
    assert.ok(result.errors.includes(code), code);
  }
  assert.deepEqual(result.errors, [...result.errors].sort());
});

test('空白 repository/headSha/candidateDigest 視為缺失', () => {
  const errors = errorsOf(payload({
    repository: '  ',
    headSha: '',
    candidateDigest: ' ',
  }));

  assert.ok(errors.includes('GITHUB_REPOSITORY_MISSING'));
  assert.ok(errors.includes('GITHUB_HEAD_SHA_MISSING'));
  assert.ok(errors.includes('GITHUB_CANDIDATE_DIGEST_MISSING'));
});

test('summary 不是 object 時回報 GITHUB_SUMMARY_MISSING', () => {
  const errors = errorsOf(payload({ summary: 'not-an-object' }));

  assert.ok(errors.includes('GITHUB_SUMMARY_MISSING'));
  assert.ok(errors.includes('GITHUB_SUMMARY_BINDING_MISSING'));
});

for (const field of ['decision', 'coverage', 'eligibility']) {
  test(`summary 缺 ${field} 時回報 GITHUB_SUMMARY_BINDING_MISSING`, () => {
    const { [field]: _removed, ...rest } = summary;
    const errors = errorsOf(payload({ summary: rest }));

    assert.ok(errors.includes('GITHUB_SUMMARY_BINDING_MISSING'));
  });
}

test('summary 結構不合 candidate contract 時回報 GITHUB_SUMMARY_INVALID', () => {
  const errors = errorsOf(payload({
    summary: { ...summary, decision: { status: 'MAYBE' } },
  }));

  assert.ok(errors.includes('GITHUB_SUMMARY_INVALID'));
});

test('payload repository 與 summary identity 不同時回報 GITHUB_IDENTITY_MISMATCH', () => {
  const errors = errorsOf(payload({ repository: 'other/repo' }));

  assert.deepEqual(errors, ['GITHUB_IDENTITY_MISMATCH']);
});

test('summary 沒有 identity 時回報 GITHUB_IDENTITY_MISMATCH', () => {
  const { identity: _removed, ...rest } = summary;
  const errors = errorsOf(payload({ summary: rest }));

  assert.ok(errors.includes('GITHUB_IDENTITY_MISMATCH'));
});

test('payload digest 與 summary digest 不同時回報 GITHUB_DIGEST_MISMATCH', () => {
  const errors = errorsOf(payload({ candidateDigest: 'sha256:other' }));

  assert.deepEqual(errors, ['GITHUB_DIGEST_MISMATCH']);
});

test('check state 只接受 PASS/FAILURE', () => {
  assert.deepEqual(
    errorsOf(payload({ check: { state: 'NEUTRAL', reason: 'X' } })),
    ['GITHUB_CHECK_STATE_INVALID'],
  );
  assert.ok(errorsOf(payload({ check: undefined })).includes('GITHUB_CHECK_STATE_INVALID'));
  assert.equal(
    validateGithubPayload(payload({ check: { state: 'FAILURE', reason: 'X' } })).valid,
    true,
  );
});

test('check reason 缺失或空白時回報 GITHUB_CHECK_REASON_INVALID', () => {
  assert.deepEqual(
    errorsOf(payload({ check: { state: 'PASS', reason: '  ' } })),
    ['GITHUB_CHECK_REASON_INVALID'],
  );
  assert.deepEqual(
    errorsOf(payload({ check: { state: 'PASS' } })),
    ['GITHUB_CHECK_REASON_INVALID'],
  );
});

test('ANALYSIS_FAILED 不得以 PASS 發布，但可以 FAILURE 發布', () => {
  const failedSummary = { ...summary, analysisStatus: 'ANALYSIS_FAILED' };

  assert.ok(
    errorsOf(payload({ summary: failedSummary })).includes('GITHUB_ANALYSIS_FAILURE_PASS'),
  );
  assert.equal(
    errorsOf(payload({
      summary: failedSummary,
      check: { state: 'FAILURE', reason: 'ANALYSIS_FAILED' },
    })).includes('GITHUB_ANALYSIS_FAILURE_PASS'),
    false,
  );
});
