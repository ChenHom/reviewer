import { sameIdentity, validateCandidate } from './contracts.js';

/**
 * 建立目前 head 與 authoritative candidate 的記憶體 authority state。
 *
 * @param {object} currentHead - 目前 repository head 的 AnalysisIdentity。
 * @returns {{currentHead: object, current: object|null}} 初始 authority state。
 */
export function createAuthorityState(currentHead) {
  return {
    currentHead,
    current: null,
  };
}

/**
 * 切換目前 repository head，並立即清除舊 authoritative result。
 *
 * @param {{currentHead: object, current: object|null}} state - authority state。
 * @param {object} currentHead - 新的 AnalysisIdentity。
 * @returns {{currentHead: object, current: object|null}} 更新後的 authority state。
 */
export function setCurrentHead(state, currentHead) {
  state.currentHead = currentHead;
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

  if (!validateCandidate(candidate).valid) {
    return { accepted: false, reason: 'CANDIDATE_INVALID' };
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
