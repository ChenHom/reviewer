import { stableStrings } from '../contracts.js';
import { validateProvenance } from '../evidence.js';

/**
 * 判斷值是否為 plain JSON object。
 *
 * @param {unknown} value - 要檢查的值。
 * @returns {boolean} 是否為 plain object。
 */
function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * 驗證 AdapterResult 中的 provider-neutral semantic facts。
 *
 * Adapter 只描述「程式發生了什麼」；Fact 不得攜帶 review decision。
 * 沒有宣告 semantic-facts capability 的既有 Adapter 可省略 facts。
 *
 * @param {unknown} facts - AdapterResult.facts。
 * @param {unknown} adapterSet - AdapterResult.adapterSet。
 * @returns {{valid: boolean, errors: string[]}} validation result。
 */
export function validateSemanticFacts(facts, adapterSet) {
  const adapters = Array.isArray(adapterSet) ? adapterSet : [];
  const semanticAdapters = adapters.filter(
    (adapter) => Array.isArray(adapter?.capabilities)
      && adapter.capabilities.includes('semantic-facts'),
  );

  if (semanticAdapters.length === 0) {
    if (facts === undefined || (Array.isArray(facts) && facts.length === 0)) {
      return { valid: true, errors: [] };
    }
    return { valid: false, errors: ['ADAPTER_FACTS_WITHOUT_CAPABILITY'] };
  }

  if (facts === undefined) {
    return { valid: false, errors: ['ADAPTER_FACTS_MISSING'] };
  }
  if (!Array.isArray(facts)) {
    return { valid: false, errors: ['ADAPTER_FACTS_INVALID'] };
  }

  const errors = [];
  const ids = facts.map((fact) => fact?.id);
  const duplicateIds = ids.filter(
    (id, index) => typeof id === 'string' && ids.indexOf(id) !== index,
  );
  for (const id of [...new Set(duplicateIds)]) {
    errors.push(`FACT_DUPLICATE_ID:${id}`);
  }

  const adapterById = new Map(
    adapters
      .filter((adapter) => typeof adapter?.id === 'string')
      .map((adapter) => [adapter.id, adapter]),
  );

  for (const fact of facts) {
    const label = typeof fact?.id === 'string' && fact.id.trim() !== '' ? fact.id : 'unknown';

    if (typeof fact?.id !== 'string' || fact.id.trim() === '') {
      errors.push('FACT_ID_MISSING');
    }
    if (typeof fact?.kind !== 'string' || fact.kind.trim() === '') {
      errors.push(`FACT_KIND_MISSING:${label}`);
    }
    if (typeof fact?.subject !== 'string' || fact.subject.trim() === '') {
      errors.push(`FACT_SUBJECT_MISSING:${label}`);
    }
    if (!isPlainObject(fact?.properties)) {
      errors.push(`FACT_PROPERTIES_INVALID:${label}`);
    }
    if (!validateProvenance(fact?.provenance)) {
      errors.push(`FACT_PROVENANCE_INVALID:${label}`);
    }

    if (!isPlainObject(fact?.source)) {
      errors.push(`FACT_SOURCE_MISSING:${label}`);
      continue;
    }

    const adapterId = fact.source.adapterId;
    const adapterVersion = fact.source.adapterVersion;
    if (typeof adapterId !== 'string' || adapterId.trim() === '') {
      errors.push(`FACT_SOURCE_ADAPTER_MISSING:${label}`);
      continue;
    }

    const adapter = adapterById.get(adapterId);
    if (!adapter) {
      errors.push(`FACT_SOURCE_ADAPTER_UNDECLARED:${label}`);
      continue;
    }
    if (!adapter.capabilities?.includes('semantic-facts')) {
      errors.push(`FACT_SOURCE_CAPABILITY_MISSING:${label}`);
    }
    if (
      typeof adapterVersion !== 'string'
      || adapterVersion.trim() === ''
      || adapterVersion !== adapter.version
    ) {
      errors.push(`FACT_SOURCE_VERSION_MISMATCH:${label}`);
    }
  }

  const stableErrors = stableStrings(errors);
  return { valid: stableErrors.length === 0, errors: stableErrors };
}
