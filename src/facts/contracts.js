import { stableStrings } from '../contracts.js';
import { validateProvenance } from '../evidence.js';

/**
 * 使用 deterministic bytewise 順序比較文字。
 *
 * @param {string} left - 左值。
 * @param {string} right - 右值。
 * @returns {number} 排序結果。
 */
function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 判斷值是否為 plain JSON object。
 *
 * @param {unknown} value - 要檢查的值。
 * @returns {boolean} 是否為 plain object。
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 驗證值是否能無損且 deterministic 地進入 JSON/digest pipeline。
 *
 * 禁止 undefined、BigInt、function、symbol、NaN/Infinity、Date/custom prototype、
 * symbol/non-enumerable/accessor property 與 circular reference。
 *
 * @param {unknown} value - 要驗證的值。
 * @param {Set<object>} [ancestors=new Set()] - recursion stack。
 * @returns {boolean} 是否為 JSON-safe value。
 */
export function isJsonSafeValue(value, ancestors = new Set()) {
  if (value === null) return true;

  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;

  if (ancestors.has(value)) return false;
  ancestors.add(value);

  if (Array.isArray(value)) {
    const valid = value.every((item) => isJsonSafeValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }

  if (!isPlainObject(value)) {
    ancestors.delete(value);
    return false;
  }

  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string') {
      ancestors.delete(value);
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      ancestors.delete(value);
      return false;
    }
    if (!isJsonSafeValue(descriptor.value, ancestors)) {
      ancestors.delete(value);
      return false;
    }
  }

  ancestors.delete(value);
  return true;
}

/**
 * canonicalize 已驗證的 JSON-safe value。
 *
 * @param {unknown} value - JSON-safe value。
 * @returns {unknown} key 排序後的 canonical value。
 */
export function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalizeJsonValue(value[key])]),
  );
}

/**
 * 將 semantic facts 轉成 deterministic canonical list。
 *
 * 呼叫端必須先通過 validateSemanticFacts。
 *
 * @param {object[]} [facts=[]] - semantic facts。
 * @returns {object[]} canonical facts。
 */
export function canonicalSemanticFacts(facts = []) {
  return facts
    .map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      subject: fact.subject,
      properties: canonicalizeJsonValue(fact.properties),
      provenance: {
        path: fact.provenance.path,
        startByte: fact.provenance.startByte,
        endByte: fact.provenance.endByte,
      },
      source: {
        adapterId: fact.source.adapterId,
        adapterVersion: fact.source.adapterVersion,
      },
    }))
    .sort((left, right) =>
      compareText(left.provenance.path, right.provenance.path)
      || left.provenance.startByte - right.provenance.startByte
      || left.provenance.endByte - right.provenance.endByte
      || compareText(left.kind, right.kind)
      || compareText(left.subject, right.subject)
      || compareText(left.id, right.id));
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
    if (!isPlainObject(fact?.properties) || !isJsonSafeValue(fact.properties)) {
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
