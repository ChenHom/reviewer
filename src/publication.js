import { sameIdentity, validateCandidate } from './contracts.js';
import {
  sameAnalysisContextBinding,
  validateAnalysisContextBinding,
} from './adapters/contracts.js';

/**
 * 建立目前 head 與 authoritative candidate 的記憶體 authority state。
 *
 * @param {object} currentHead - 目前 repository head 的 AnalysisIdentity。
 * @param {object|undefined} [currentContextBinding] - 目前 head 的 adapter/runtime binding。
 * @returns {{currentHead: object, currentContextBinding: object|undefined, current: object|null}} 初始 authority state。
 */
export function createAuthorityState(currentHead, currentContextBinding) {
  return {
    currentHead,
    currentContextBinding,
    current: null,
  };
}

/**
 * 切換目前 repository head，並立即清除舊 authoritative result。
 *
 * @param {{currentHead: object, currentContextBinding: object|undefined, current: object|null}} state - authority state。
 * @param {object} currentHead - 新的 AnalysisIdentity。
 * @param {object|undefined} [currentContextBinding] - 新 head 的 adapter/runtime binding。
 * @returns {{currentHead: object, currentContextBinding: object|undefined, current: object|null}} 更新後的 authority state。
 */
export function setCurrentHead(state, currentHead, currentContextBinding) {
  state.currentHead = currentHead;
  state.currentContextBinding = currentContextBinding;
  state.current = null;
  return state;
}

/**
 * 檢查 candidate 是否具備 publication 所需的外層欄位。
 *
 * @param {object|undefined} candidate - 要檢查的 candidate。
 * @returns {boolean} candidate 是否具備完整外層欄位。
 */
function hasCandidateEnvelope(candidate) {
  return Boolean(
    candidate
    && candidate.identity
    && typeof candidate.analysisStatus === 'string'
    && candidate.coverage
    && candidate.eligibility
    && candidate.decision,
  );
}

/**
 * 驗證並發布與目前 identity 相符的 authoritative candidate。
 *
 * @param {{currentHead: object, current: object|null}} state - authority state。
 * @param {object|undefined} candidate - 要發布的 candidate。
 * @returns {{accepted: boolean, reason?: string, current?: object}} publication 結果。
 */
export function publishCandidate(state, candidate) {
  if (!hasCandidateEnvelope(candidate)) {
    return { accepted: false, reason: 'CANDIDATE_INCOMPLETE' };
  }

  if (
    candidate.contextBinding !== undefined
    && !validateAnalysisContextBinding(candidate.contextBinding).valid
  ) {
    return { accepted: false, reason: 'CANDIDATE_CONTEXT_BINDING_INVALID' };
  }

  if (!validateCandidate(candidate).valid) {
    return { accepted: false, reason: 'CANDIDATE_INVALID' };
  }

  if (!sameIdentity(candidate.identity, state.currentHead)) {
    return { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' };
  }

  const candidateHasContext = candidate.contextBinding !== undefined;
  const authorityHasContext = state.currentContextBinding !== undefined;
  if (authorityHasContext && !validateAnalysisContextBinding(state.currentContextBinding).valid) {
    return { accepted: false, reason: 'AUTHORITY_CONTEXT_BINDING_INVALID' };
  }
  if (candidateHasContext !== authorityHasContext) {
    return { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' };
  }
  if (
    candidateHasContext
    && !sameAnalysisContextBinding(candidate.contextBinding, state.currentContextBinding)
  ) {
    return { accepted: false, reason: 'STALE_ANALYSIS_IDENTITY' };
  }

  state.current = {
    ...candidate,
    authoritative: true,
  };

  return { accepted: true, current: state.current };
}

/**
 * 透過 authority store 的 CAS 發布 candidate。
 *
 * @param {{compareAndSwapCurrent: function}} store - storage-backed authority store。
 * @param {object|undefined} candidate - 要發布的 candidate。
 * @returns {{accepted: boolean, idempotent?: boolean, reason?: string, current?: object}} CAS publication 結果。
 */
export function publishCandidateToStore(store, candidate) {
  if (!store || typeof store.compareAndSwapCurrent !== 'function') {
    return { accepted: false, reason: 'AUTHORITY_STORE_INVALID' };
  }
  if (!hasCandidateEnvelope(candidate) || !validateCandidate(candidate).valid) {
    return { accepted: false, reason: 'CANDIDATE_INVALID' };
  }

  return store.compareAndSwapCurrent({
    repository: candidate.identity.repository,
    expectedHead: candidate.identity,
    candidate,
  });
}
