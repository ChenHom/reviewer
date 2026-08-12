import { sameIdentity } from './contracts.js';

export function createAuthorityState(currentHead) {
  return {
    currentHead,
    current: null,
  };
}

export function setCurrentHead(state, currentHead) {
  state.currentHead = currentHead;
  state.current = null;
  return state;
}

function isCompleteCandidate(candidate) {
  return Boolean(
    candidate
    && candidate.identity
    && typeof candidate.analysisStatus === 'string'
    && candidate.coverage
    && candidate.eligibility
    && candidate.decision,
  );
}

export function publishCandidate(state, candidate) {
  if (!isCompleteCandidate(candidate)) {
    return { accepted: false, reason: 'CANDIDATE_INCOMPLETE' };
  }

  if (!sameIdentity(candidate.identity, state.currentHead)) {
    return { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' };
  }

  state.current = {
    ...candidate,
    authoritative: true,
  };

  return { accepted: true, current: state.current };
}
