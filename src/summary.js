import { sameIdentity } from './contracts.js';

export function buildSummary(candidate) {
  return {
    identity: candidate.identity,
    analysisStatus: candidate.analysisStatus,
    coverage: candidate.coverage,
    eligibility: candidate.eligibility,
    decision: candidate.decision,
  };
}

export function publishSummary(summary, { succeed = true } = {}) {
  if (!succeed) {
    return { published: false, reason: 'SUMMARY_PUBLICATION_FAILED' };
  }

  return {
    published: true,
    identity: summary.identity,
    summary,
  };
}

export function deriveCheckState({ candidate, summary, currentIdentity } = {}) {
  if (!summary) {
    return { state: 'FAILURE', reason: 'SUMMARY_MISSING' };
  }

  if (!summary.published) {
    return { state: 'FAILURE', reason: summary.reason ?? 'SUMMARY_PUBLICATION_FAILED' };
  }

  if (!candidate?.authoritative) {
    return { state: 'FAILURE', reason: 'CANDIDATE_NOT_AUTHORITATIVE' };
  }

  if (
    !sameIdentity(candidate.identity, currentIdentity)
    || !sameIdentity(summary.identity, currentIdentity)
  ) {
    return { state: 'FAILURE', reason: 'STALE_ANALYSIS_IDENTITY' };
  }

  if (candidate.analysisStatus === 'ANALYSIS_FAILED') {
    return { state: 'FAILURE', reason: 'ANALYSIS_FAILED' };
  }

  return { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' };
}
