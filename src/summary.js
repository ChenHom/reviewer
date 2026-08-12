import { createHash } from 'node:crypto';
import { sameIdentity, validateCandidate } from './contracts.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function candidateDigest(candidate) {
  const payload = {
    identity: candidate.identity,
    analysisStatus: candidate.analysisStatus,
    coverage: candidate.coverage,
    eligibility: candidate.eligibility,
    decision: candidate.decision,
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

export function buildSummary(candidate) {
  return {
    identity: candidate.identity,
    analysisStatus: candidate.analysisStatus,
    coverage: candidate.coverage,
    eligibility: candidate.eligibility,
    decision: candidate.decision,
    candidateDigest: candidateDigest(candidate),
  };
}

export function publishSummary(summary, { succeed = true } = {}) {
  if (!succeed) {
    return { published: false, reason: 'SUMMARY_PUBLICATION_FAILED' };
  }

  if (!summary || !summary.identity || typeof summary.candidateDigest !== 'string') {
    return { published: false, reason: 'SUMMARY_INVALID' };
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

  if (!validateCandidate(candidate).valid) {
    return { state: 'FAILURE', reason: 'CANDIDATE_INVALID' };
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

  if (
    summary.summary?.candidateDigest !== candidateDigest(candidate)
    || candidateDigest(summary.summary) !== summary.summary?.candidateDigest
  ) {
    return { state: 'FAILURE', reason: 'SUMMARY_CANDIDATE_MISMATCH' };
  }

  return { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' };
}
