import { stableStrings } from './contracts.js';

/**
 * 驗證 evidence provenance 是否能定位到非空 source range。
 *
 * @param {unknown} provenance - evidence provenance。
 * @returns {boolean} provenance 是否合法。
 */
export function validateProvenance(provenance) {
  return Boolean(
    provenance
    && typeof provenance.path === 'string'
    && provenance.path.trim() !== ''
    && Number.isInteger(provenance.startByte)
    && Number.isInteger(provenance.endByte)
    && provenance.startByte >= 0
    && provenance.endByte > provenance.startByte,
  );
}

/**
 * 將 provenance 轉為可比較的 stable key。
 *
 * @param {object} provenance - 合法 provenance。
 * @returns {string} provenance key。
 */
export function provenanceKey(provenance) {
  return JSON.stringify([
    provenance.path,
    provenance.startByte,
    provenance.endByte,
  ]);
}

/**
 * 驗證 normalized evidence item 與其 provenance。
 *
 * @param {{items?: object[]}} [input={}] - evidence collection。
 * @returns {{valid: boolean, blockers: string[], items: object[]}} evidence validation result。
 */
export function validateEvidence({ items } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, blockers: ['EVIDENCE_MISSING'], items: [] };
  }

  const blockers = [];
  const ids = items.map((item) => item?.id);
  const duplicateIds = ids
    .filter((id, index) => typeof id === 'string' && ids.indexOf(id) !== index);

  for (const id of [...new Set(duplicateIds)]) {
    blockers.push(`EVIDENCE_DUPLICATE_ID:${id}`);
  }

  for (const item of items) {
    const label = typeof item?.id === 'string' && item.id.trim() !== '' ? item.id : 'unknown';

    if (typeof item?.id !== 'string' || item.id.trim() === '') {
      blockers.push('EVIDENCE_ID_MISSING');
    }
    if (typeof item?.source !== 'string' || item.source.trim() === '') {
      blockers.push('EVIDENCE_SOURCE_MISSING');
    }
    if (typeof item?.subject !== 'string' || item.subject.trim() === '') {
      blockers.push('EVIDENCE_SUBJECT_MISSING');
    }
    if (typeof item?.kind !== 'string' || item.kind.trim() === '') {
      blockers.push(`EVIDENCE_KIND_MISSING:${label}`);
    }
    if (typeof item?.complete !== 'boolean') {
      blockers.push(`EVIDENCE_COMPLETE_INVALID:${label}`);
    } else if (!item.complete) {
      blockers.push(`EVIDENCE_COMPLETE_FALSE:${label}`);
    }
    if (!validateProvenance(item?.provenance)) {
      blockers.push(`EVIDENCE_PROVENANCE_INVALID:${label}`);
    }
  }

  return {
    valid: blockers.length === 0,
    blockers: stableStrings(blockers),
    items,
  };
}
