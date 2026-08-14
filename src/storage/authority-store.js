import {
  sameAnalysisContextBinding,
  validateAnalysisContextBinding,
} from '../adapters/contracts.js';

/**
 * Authority storage CAS failure reasons。
 */
export const STORAGE_REASONS = Object.freeze({
  STALE: 'AUTHORITY_CAS_STALE',
  CONFLICT: 'AUTHORITY_CAS_CONFLICT',
});

/**
 * 比較 candidate 與 persisted authority 的 context binding。
 *
 * @param {object|undefined} candidateBinding - candidate context binding。
 * @param {object|undefined} authorityBinding - persisted context binding。
 * @returns {boolean} binding 是否一致且合法。
 */
export function sameStoredContextBinding(candidateBinding, authorityBinding) {
  const candidateHasBinding = candidateBinding !== undefined;
  const authorityHasBinding = authorityBinding !== undefined;
  if (candidateHasBinding !== authorityHasBinding) return false;
  if (!candidateHasBinding) return true;
  return validateAnalysisContextBinding(authorityBinding).valid
    && sameAnalysisContextBinding(candidateBinding, authorityBinding);
}

/**
 * Authority store port。
 *
 * @typedef {object} AuthorityStore
 * @property {function(string): object|null} readCurrentHead - 讀取目前 repository head。
 * @property {function(string): object|null} readCurrent - 讀取 authoritative candidate。
 * @property {function(object): object} advanceCurrentHead - CAS 更新 head 並清除 candidate。
 * @property {function(object): object} compareAndSwapCurrent - CAS 寫入 candidate。
 */
