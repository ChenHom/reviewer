import { createHash } from 'node:crypto';
import { sameIdentity, validateCandidate } from './contracts.js';

/**
 * 將可雜湊的資料遞迴轉為 key 穩定排序的 canonical value。
 *
 * @param {unknown} value - 要 canonicalize 的資料。
 * @returns {unknown} key 排序後的 canonical value。
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

/**
 * 計算 authoritative candidate 的 canonical SHA-256 digest。
 *
 * @param {object} candidate - 要計算 digest 的 candidate。
 * @returns {string} candidate digest。
 */
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

/**
 * 從 authoritative candidate 建立 Summary payload。
 *
 * @param {object} candidate - authoritative candidate。
 * @returns {object} 包含 candidate digest 的 Summary payload。
 */
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

/**
 * 發布 Summary，並回傳 publication 結果。
 *
 * @param {object|undefined} summary - 要發布的 Summary payload。
 * @param {{succeed?: boolean}} [options={}] - 控制 publication 成功與否的選項。
 * @returns {{published: boolean, reason?: string, identity?: object, summary?: object}} publication 結果。
 */
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

/**
 * 驗證 candidate、Summary 與目前 identity 的綁定狀態。
 *
 * @param {object} [options={}] - status check 輸入。
 * @returns {{state: string, reason: string}} status check 結果。
 */
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
