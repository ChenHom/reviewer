import { stableStrings } from './contracts.js';
import { validateProvenance } from './evidence.js';

/**
 * 將 invariant mapping 轉為 stable identity。
 *
 * @param {object} mapping - invariant mapping。
 * @returns {string} mapping identity。
 */
function mappingKey(mapping) {
  return `${mapping.invariantId}:${mapping.subject}`;
}

/**
 * 將 required invariants 與 changed subjects 對應到可追溯 mapping。
 *
 * @param {{changedSubjects?: string[], mappings?: object[], requiredInvariants?: string[]}} [input={}] - invariant facts。
 * @returns {{valid: boolean, blockers: string[], mappings: object[]}} invariant mapping result。
 */
export function mapInvariants({
  changedSubjects = [],
  mappings = [],
  requiredInvariants = [],
} = {}) {
  const blockers = [];
  const safeSubjects = Array.isArray(changedSubjects) ? changedSubjects : [];
  const safeMappings = Array.isArray(mappings) ? mappings : [];
  const safeRequired = Array.isArray(requiredInvariants) ? requiredInvariants : [];

  if (!Array.isArray(changedSubjects)) blockers.push('INVARIANT_CHANGED_SUBJECTS_INVALID');
  if (!Array.isArray(mappings)) blockers.push('INVARIANT_MAPPINGS_INVALID');
  if (!Array.isArray(requiredInvariants) || safeRequired.length === 0) {
    blockers.push('INVARIANT_REQUIRED_SET_MISSING');
  }

  const mappingKeys = new Set();
  for (const mapping of safeMappings) {
    const key = (
      typeof mapping?.invariantId === 'string' && typeof mapping?.subject === 'string'
    ) ? mappingKey(mapping) : null;
    if (key && mappingKeys.has(key)) blockers.push(`INVARIANT_DUPLICATE_MAPPING:${mapping.invariantId}`);
    if (key) mappingKeys.add(key);
  }

  for (const invariantId of safeRequired) {
    const candidates = safeMappings.filter((mapping) => mapping?.invariantId === invariantId);
    if (candidates.length === 0) {
      blockers.push(`INVARIANT_MAPPING_MISSING:${invariantId}`);
      continue;
    }

    for (const mapping of candidates) {
      if (
        typeof mapping.subject !== 'string'
        || !safeSubjects.includes(mapping.subject)
        || !validateProvenance(mapping.provenance)
        || !validateProvenance(mapping.evidenceProvenance)
        || JSON.stringify(mapping.provenance) !== JSON.stringify(mapping.evidenceProvenance)
      ) {
        blockers.push(`INVARIANT_PROVENANCE_MISMATCH:${invariantId}`);
      }
    }
  }

  return {
    valid: blockers.length === 0,
    blockers: stableStrings(blockers),
    mappings: safeMappings,
  };
}
