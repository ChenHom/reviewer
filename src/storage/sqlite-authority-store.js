import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sameIdentity, validateCandidate } from '../contracts.js';
import { candidateDigest } from '../summary.js';
import { sameStoredContextBinding, STORAGE_REASONS } from './authority-store.js';

const IDENTITY_FIELDS = [
  'repository',
  'baseSha',
  'headSha',
  'policyId',
  'policyVersion',
  'runnerVersion',
];

/**
 * 將 identity 轉成欄位順序固定的 CAS key。
 *
 * @param {object} identity - AnalysisIdentity。
 * @returns {string} stable identity key。
 */
function identityKey(identity) {
  return JSON.stringify(IDENTITY_FIELDS.map((field) => identity?.[field] ?? null));
}

/**
 * 將資料庫 row 轉回可用 authority record。
 *
 * @param {object|null} row - SQLite row。
 * @returns {{repository: string, currentHead: object, currentContextBinding?: object, current: object|null}|null} parsed record。
 */
function parseRow(row) {
  if (!row) return null;
  const current = row.candidate_json ? JSON.parse(row.candidate_json) : null;
  if (current && !Object.hasOwn(current, 'contextBinding')) current.contextBinding = undefined;
  return {
    repository: row.repository,
    currentHead: JSON.parse(row.head_json),
    currentContextBinding: row.context_json ? JSON.parse(row.context_json) : undefined,
    current,
  };
}

/**
 * 在 SQLite transaction 中執行 callback，錯誤時 rollback。
 *
 * @param {DatabaseSync} database - SQLite database。
 * @param {function(): object} callback - transaction body。
 * @returns {object} callback result。
 */
function transaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Node.js 24 SQLite authority store。
 */
export class SqliteAuthorityStore {
  /**
   * 開啟 SQLite authority database 並建立 schema。
   *
   * @param {string} filename - SQLite database path，`:memory:` 可供 unit tests 使用。
   */
  constructor(filename = ':memory:') {
    this.database = new DatabaseSync(filename);
    this.database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }

  /**
   * 初始化 repository row；已存在 row 時保持 persisted authority 不變。
   *
   * @param {{repository: string, currentHead: object, currentContextBinding?: object}} options - 初始 authority。
   * @returns {{accepted: boolean}} initialization result。
   */
  initialize({ repository, currentHead, currentContextBinding } = {}) {
    this.database.prepare(`
      INSERT OR IGNORE INTO authority_current
        (repository, head_key, head_json, context_json, candidate_digest, candidate_json, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      repository,
      identityKey(currentHead),
      JSON.stringify(currentHead),
      currentContextBinding === undefined ? null : JSON.stringify(currentContextBinding),
      new Date().toISOString(),
    );
    return { accepted: true };
  }

  /**
   * 讀取指定 repository 的 persisted current head。
   *
   * @param {string} repository - repository id。
   * @returns {object|null} current head。
   */
  readCurrentHead(repository) {
    return parseRow(this.database.prepare(
      'SELECT repository, head_json, context_json, candidate_json FROM authority_current WHERE repository = ?',
    ).get(repository))?.currentHead ?? null;
  }

  /**
   * 讀取指定 repository 的 persisted authoritative candidate。
   *
   * @param {string} repository - repository id。
   * @returns {object|null} authoritative candidate。
   */
  readCurrent(repository) {
    return parseRow(this.database.prepare(
      'SELECT repository, head_json, context_json, candidate_json FROM authority_current WHERE repository = ?',
    ).get(repository))?.current ?? null;
  }

  /**
   * 在同一 transaction 更新 head 並清除 current candidate。
   *
   * @param {{repository: string, expectedHead: object, nextHead: object, nextContextBinding?: object}} request - head transition。
   * @returns {{accepted: boolean, reason?: string, currentHead?: object}} transition result。
   */
  advanceCurrentHead({ repository, expectedHead, nextHead, nextContextBinding } = {}) {
    return transaction(this.database, () => {
      const row = this.database.prepare(
        'SELECT head_key FROM authority_current WHERE repository = ?',
      ).get(repository);
      if (!row || row.head_key !== identityKey(expectedHead)) {
        return { accepted: false, reason: STORAGE_REASONS.STALE };
      }

      const result = this.database.prepare(`
        UPDATE authority_current
        SET head_key = ?, head_json = ?, context_json = ?, candidate_digest = NULL,
            candidate_json = NULL, updated_at = ?
        WHERE repository = ? AND head_key = ?
      `).run(
        identityKey(nextHead),
        JSON.stringify(nextHead),
        nextContextBinding === undefined ? null : JSON.stringify(nextContextBinding),
        new Date().toISOString(),
        repository,
        identityKey(expectedHead),
      );
      if (result.changes !== 1) return { accepted: false, reason: STORAGE_REASONS.STALE };
      return { accepted: true, currentHead: nextHead };
    });
  }

  /**
   * 以 persisted head 與 candidate digest 執行 SQLite CAS publication。
   *
   * @param {{repository: string, expectedHead: object, candidate: object}} request - candidate CAS request。
   * @returns {{accepted: boolean, idempotent?: boolean, reason?: string, current?: object}} CAS result。
   */
  compareAndSwapCurrent({ repository, expectedHead, candidate } = {}) {
    return transaction(this.database, () => {
      const row = this.database.prepare(`
        SELECT repository, head_key, head_json, context_json, candidate_digest, candidate_json
        FROM authority_current WHERE repository = ?
      `).get(repository);
      if (!row || row.head_key !== identityKey(expectedHead)) {
        return { accepted: false, reason: STORAGE_REASONS.STALE };
      }
      if (!sameIdentity(candidate?.identity, expectedHead)) {
        return { accepted: false, reason: STORAGE_REASONS.STALE };
      }
      const authorityContextBinding = row.context_json
        ? JSON.parse(row.context_json)
        : undefined;
      if (!sameStoredContextBinding(candidate?.contextBinding, authorityContextBinding)) {
        return { accepted: false, reason: STORAGE_REASONS.STALE };
      }
      if (!validateCandidate(candidate).valid) {
        return { accepted: false, reason: 'CANDIDATE_INVALID' };
      }

      const digest = candidateDigest(candidate);
      if (row.candidate_digest) {
        if (row.candidate_digest === digest) {
          return {
            accepted: true,
            idempotent: true,
            current: JSON.parse(row.candidate_json),
          };
        }
        return { accepted: false, reason: STORAGE_REASONS.CONFLICT };
      }

      const authoritative = { ...candidate, authoritative: true };
      const result = this.database.prepare(`
        UPDATE authority_current
        SET candidate_digest = ?, candidate_json = ?, updated_at = ?
        WHERE repository = ? AND head_key = ? AND candidate_digest IS NULL
      `).run(
        digest,
        JSON.stringify(authoritative),
        new Date().toISOString(),
        repository,
        identityKey(expectedHead),
      );
      if (result.changes !== 1) return { accepted: false, reason: STORAGE_REASONS.STALE };
      return { accepted: true, current: authoritative };
    });
  }

  /**
   * 關閉 SQLite connection。
   *
   * @returns {void} 無回傳值。
   */
  close() {
    this.database.close();
  }
}
