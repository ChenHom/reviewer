import { sameIdentity, stableStrings, validateCandidate } from '../../contracts.js';

/**
 * 驗證 provider-neutral GitHub sink payload 的 authority binding。
 *
 * @param {object|undefined} payload - Summary/check sink payload。
 * @returns {{valid: boolean, errors: string[]}} payload validation result。
 */
export function validateGithubPayload(payload) {
  const errors = [];
  const summary = payload?.summary;
  const summaryIdentity = summary?.identity;

  if (typeof payload?.repository !== 'string' || payload.repository.trim() === '') {
    errors.push('GITHUB_REPOSITORY_MISSING');
  }
  if (typeof payload?.headSha !== 'string' || payload.headSha.trim() === '') {
    errors.push('GITHUB_HEAD_SHA_MISSING');
  }
  if (typeof payload?.candidateDigest !== 'string' || payload.candidateDigest.trim() === '') {
    errors.push('GITHUB_CANDIDATE_DIGEST_MISSING');
  }
  if (!summary || typeof summary !== 'object') {
    errors.push('GITHUB_SUMMARY_MISSING');
  }
  if (!summary?.decision || !summary?.coverage || !summary?.eligibility) {
    errors.push('GITHUB_SUMMARY_BINDING_MISSING');
  }
  if (summary && !validateCandidate(summary).valid) errors.push('GITHUB_SUMMARY_INVALID');
  if (!summaryIdentity || !sameIdentity(summaryIdentity, {
    repository: payload?.repository,
    baseSha: summaryIdentity?.baseSha,
    headSha: payload?.headSha,
    policyId: summaryIdentity?.policyId,
    policyVersion: summaryIdentity?.policyVersion,
    runnerVersion: summaryIdentity?.runnerVersion,
  })) {
    errors.push('GITHUB_IDENTITY_MISMATCH');
  }
  if (summary?.candidateDigest !== payload?.candidateDigest) {
    errors.push('GITHUB_DIGEST_MISMATCH');
  }

  const checkState = payload?.check?.state;
  if (!['PASS', 'FAILURE'].includes(checkState)) errors.push('GITHUB_CHECK_STATE_INVALID');
  if (typeof payload?.check?.reason !== 'string' || payload.check.reason.trim() === '') {
    errors.push('GITHUB_CHECK_REASON_INVALID');
  }
  if (summary?.analysisStatus === 'ANALYSIS_FAILED' && checkState === 'PASS') {
    errors.push('GITHUB_ANALYSIS_FAILURE_PASS');
  }

  return { valid: errors.length === 0, errors: stableStrings(errors) };
}
