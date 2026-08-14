import { sameIdentity, validateCandidate } from '../contracts.js';
import { candidateDigest } from '../summary.js';
import { sameStoredContextBinding, STORAGE_REASONS } from './authority-store.js';

/**
 * 建立不共享外部物件 reference 的 clone。
 *
 * @param {unknown} value - 要 clone 的值。
 * @returns {unknown} cloned value。
 */
function clone(value) {
  return value === null || value === undefined ? value : globalThis.structuredClone(value);
}

/**
 * 比較 store request 是否仍指向指定 repository/head。
 *
 * @param {object} record - memory authority record。
 * @param {string} repository - repository id。
 * @param {object} expectedHead - 預期 head identity。
 * @returns {boolean} 是否仍可進行 CAS。
 */
function matchesExpectedHead(record, repository, expectedHead) {
  return record.repository === repository && sameIdentity(record.currentHead, expectedHead);
}

/**
 * 記憶體版 authority store，供 deterministic unit tests 使用。
 */
export class MemoryAuthorityStore {
  /**
   * 建立 memory authority store。
   *
   * @param {{repository: string, currentHead: object, currentContextBinding?: object}} options - 初始 authority。
   */
  constructor({ repository, currentHead, currentContextBinding } = {}) {
    this.record = {
      repository,
      currentHead: clone(currentHead),
      currentContextBinding: clone(currentContextBinding),
      current: null,
    };
  }

  /**
   * 讀取指定 repository 的 current head。
   *
   * @param {string} repository - repository id。
   * @returns {object|null} current head。
   */
  readCurrentHead(repository) {
    if (repository !== this.record.repository) return null;
    return clone(this.record.currentHead);
  }

  /**
   * 讀取指定 repository 的 authoritative candidate。
   *
   * @param {string} repository - repository id。
   * @returns {object|null} authoritative candidate。
   */
  readCurrent(repository) {
    if (repository !== this.record.repository) return null;
    return clone(this.record.current);
  }

  /**
   * 以 expected head 原子切換 current head 並清除舊 candidate。
   *
   * @param {{repository: string, expectedHead: object, nextHead: object, nextContextBinding?: object}} request - head transition。
   * @returns {{accepted: boolean, reason?: string, currentHead?: object}} transition result。
   */
  advanceCurrentHead({ repository, expectedHead, nextHead, nextContextBinding } = {}) {
    if (!matchesExpectedHead(this.record, repository, expectedHead)) {
      return { accepted: false, reason: STORAGE_REASONS.STALE };
    }

    this.record.currentHead = clone(nextHead);
    this.record.currentContextBinding = clone(nextContextBinding);
    this.record.current = null;
    return { accepted: true, currentHead: clone(nextHead) };
  }

  /**
   * 以 persisted current head 條件寫入 authoritative candidate。
   *
   * @param {{repository: string, expectedHead: object, candidate: object}} request - candidate CAS request。
   * @returns {{accepted: boolean, idempotent?: boolean, reason?: string, current?: object}} CAS result。
   */
  compareAndSwapCurrent({ repository, expectedHead, candidate } = {}) {
    if (!matchesExpectedHead(this.record, repository, expectedHead)) {
      return { accepted: false, reason: STORAGE_REASONS.STALE };
    }
    if (!sameIdentity(candidate?.identity, expectedHead)) {
      return { accepted: false, reason: STORAGE_REASONS.STALE };
    }
    if (!sameStoredContextBinding(candidate?.contextBinding, this.record.currentContextBinding)) {
      return { accepted: false, reason: STORAGE_REASONS.STALE };
    }
    if (!validateCandidate(candidate).valid) {
      return { accepted: false, reason: 'CANDIDATE_INVALID' };
    }

    const digest = candidateDigest(candidate);
    if (this.record.current) {
      if (candidateDigest(this.record.current) === digest) {
        return {
          accepted: true,
          idempotent: true,
          current: clone(this.record.current),
        };
      }
      return { accepted: false, reason: STORAGE_REASONS.CONFLICT };
    }

    this.record.current = { ...clone(candidate), authoritative: true };
    return { accepted: true, current: clone(this.record.current) };
  }
}

/**
 * 建立 memory authority store。
 *
 * @param {{repository: string, currentHead: object, currentContextBinding?: object}} options - 初始 authority。
 * @returns {MemoryAuthorityStore} memory store。
 */
export function createMemoryAuthorityStore(options) {
  return new MemoryAuthorityStore(options);
}
