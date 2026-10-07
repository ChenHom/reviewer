import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const CORPUS_LABELS = Object.freeze(['unchanged', 'safe', 'risky']);

const REPO_LABEL = /^[A-Za-z0-9._-]+$/;

/**
 * 解析 `--repo label=path` 參數。
 *
 * @param {string[]} values - CLI 傳入的 `label=path` 字串。
 * @returns {Map<string, string>} label → repo path。
 */
export function parseRepoOptions(values = []) {
  const repos = new Map();
  for (const value of values) {
    const separator = value.indexOf('=');
    const label = separator > 0 ? value.slice(0, separator) : '';
    const path = separator > 0 ? value.slice(separator + 1) : '';
    if (!REPO_LABEL.test(label) || path === '') {
      throw new Error(`REPO_OPTION_INVALID:${value}（格式為 label=path，label 只能含英數字、. _ -）`);
    }
    if (repos.has(label)) {
      throw new Error(`REPO_LABEL_DUPLICATED:${label}`);
    }
    repos.set(label, path);
  }

  return repos;
}

/**
 * 解析 JSONL 文字；空行略過，格式錯誤時回報行號。
 *
 * @param {string} text - JSONL 內容。
 * @returns {object[]} 每行一筆 parsed object。
 */
export function parseJsonl(text) {
  const rows = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`JSONL_INVALID:line ${index + 1}`);
    }
  });

  return rows;
}

/**
 * 驗證 corpus 單筆 mutation 的格式。
 *
 * @param {unknown} row - corpus row。
 * @returns {string[]} 錯誤代碼；空陣列代表合法。
 */
export function validateCorpusRow(row) {
  const errors = [];
  if (!row || typeof row !== 'object') return ['CORPUS_ROW_NOT_OBJECT'];
  if (typeof row.repo !== 'string' || !REPO_LABEL.test(row.repo)) errors.push('CORPUS_REPO_INVALID');
  if (typeof row.path !== 'string' || row.path === '') errors.push('CORPUS_PATH_INVALID');
  if (typeof row.op !== 'string' || row.op === '') errors.push('CORPUS_OP_INVALID');
  if (!CORPUS_LABELS.includes(row.label)) errors.push('CORPUS_LABEL_INVALID');
  if (typeof row.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sourceSha256)) {
    errors.push('CORPUS_SOURCE_HASH_INVALID');
  }
  if (!Array.isArray(row.edits) || !row.edits.every((edit) => (
    Array.isArray(edit)
    && edit.length === 3
    && Number.isInteger(edit[0])
    && Number.isInteger(edit[1])
    && edit[0] >= 0
    && edit[1] >= edit[0]
    && typeof edit[2] === 'string'
  ))) {
    errors.push('CORPUS_EDITS_INVALID');
  } else if (row.label === 'unchanged' ? row.edits.length !== 0 : row.edits.length === 0) {
    errors.push('CORPUS_EDITS_LABEL_MISMATCH');
  }
  if (row.label === 'unchanged' && typeof row.parseable !== 'boolean') {
    errors.push('CORPUS_PARSEABLE_INVALID');
  }

  return errors;
}

/**
 * 計算 bytes 的 sha256（hex）。
 *
 * @param {Buffer} bytes - 原始檔案內容。
 * @returns {string} hex digest。
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 以 byte offset 套用 edits（與 PHP generator 相同語意），edits 不可重疊或超出範圍。
 *
 * @param {Buffer} source - 原始檔案 bytes。
 * @param {Array<[number, number, string]>} edits - [start, end, replacement]。
 * @returns {Buffer} 套用後的 bytes。
 */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((left, right) => right[0] - left[0] || right[1] - left[1]);
  let result = source;
  let previousStart = source.length;

  for (const [start, end, replacement] of sorted) {
    if (start < 0 || end < start || end > previousStart) {
      throw new Error(`EDIT_RANGE_INVALID:${start}-${end}`);
    }
    result = Buffer.concat([
      result.subarray(0, start),
      Buffer.from(replacement, 'utf8'),
      result.subarray(end),
    ]);
    previousStart = start;
  }

  return result;
}
