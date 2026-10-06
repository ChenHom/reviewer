import { createHash } from 'node:crypto';
import { stableStrings } from '../contracts.js';
import { validateSemanticFacts } from '../facts/contracts.js';

export const ADAPTER_STATUSES = Object.freeze([
  'COMPLETE',
  'PARTIAL_PARSE',
  'UNSUPPORTED',
  'TIMEOUT',
  'TRUNCATED',
  'FAILED',
]);

export const ADAPTER_CAPABILITIES = Object.freeze([
  'changed-regions',
  'runtime-context',
  'coverage-obligations',
  'evidence-references',
  'semantic-facts',
]);

const adapterCapabilities = new Set(ADAPTER_CAPABILITIES);
const runtimeNamespaces = new Set(['server', 'client', 'edge', 'worker', 'external', 'unknown']);

/**
 * 使用不受 locale 影響的字串順序進行 canonical sorting。
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
 * 將 JSON 值轉為 key 穩定排序的值，供 digest 使用。
 *
 * @param {unknown} value - 要正規化的值。
 * @returns {unknown} key 穩定排序後的值。
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
 * 對 canonical value 計算 SHA-256 digest。
 *
 * @param {unknown} value - 要雜湊的值。
 * @returns {string} 十六進位 SHA-256 digest。
 */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * 驗證 AdapterSet。
 *
 * @param {unknown} adapterSet - Adapter descriptor 集合。
 * @returns {string[]} 穩定錯誤碼。
 */
function validateAdapterSet(adapterSet) {
  if (!Array.isArray(adapterSet) || adapterSet.length === 0) return ['ADAPTER_SET_MISSING'];

  const errors = [];
  const ids = adapterSet.map((adapter) => adapter?.id);
  if (new Set(ids).size !== ids.length) errors.push('ADAPTER_SET_DUPLICATE_ID');

  for (const adapter of adapterSet) {
    const id = typeof adapter?.id === 'string' && adapter.id.trim() !== '' ? adapter.id : 'unknown';
    if (id === 'unknown') errors.push('ADAPTER_ID_MISSING');
    if (typeof adapter?.version !== 'string' || adapter.version.trim() === '') {
      errors.push(`ADAPTER_VERSION_MISSING:${id}`);
    }
    if (!Array.isArray(adapter?.languages) || adapter.languages.length === 0) {
      errors.push(`ADAPTER_LANGUAGES_MISSING:${id}`);
    } else if (adapter.languages.some((language) => typeof language !== 'string' || language.trim() === '')) {
      errors.push(`ADAPTER_LANGUAGES_INVALID:${id}`);
    } else if (new Set(adapter.languages).size !== adapter.languages.length) {
      errors.push(`ADAPTER_LANGUAGES_DUPLICATE:${id}`);
    }
    if (!Array.isArray(adapter?.capabilities) || adapter.capabilities.length === 0) {
      errors.push(`ADAPTER_CAPABILITIES_MISSING:${id}`);
    } else if (
      adapter.capabilities.some(
        (capability) => typeof capability !== 'string' || capability.trim() === '',
      )
    ) {
      errors.push(`ADAPTER_CAPABILITIES_INVALID:${id}`);
    } else {
      if (new Set(adapter.capabilities).size !== adapter.capabilities.length) {
        errors.push(`ADAPTER_CAPABILITIES_DUPLICATE:${id}`);
      }
      for (const capability of adapter.capabilities) {
        if (!adapterCapabilities.has(capability)) {
          errors.push(`ADAPTER_CAPABILITY_UNKNOWN:${id}:${capability}`);
        }
      }
    }
  }

  return stableStrings(errors);
}

/**
 * 將 runtime context 正規化為可比較格式。
 *
 * @param {unknown} context - region runtime context。
 * @returns {{id: string, namespace: string, source: string, version: string|null}|null} 正規化 context。
 */
export function canonicalRuntimeContext(context) {
  if (
    !context
    || typeof context !== 'object'
    || !runtimeNamespaces.has(context.namespace)
    || typeof context.id !== 'string'
    || context.id.trim() === ''
    || typeof context.source !== 'string'
    || context.source.trim() === ''
    || (context.version !== undefined && (typeof context.version !== 'string' || context.version.trim() === ''))
  ) return null;

  return {
    id: context.id,
    namespace: context.namespace,
    source: context.source,
    version: context.version ?? null,
  };
}

/**
 * 驗證 Adapter obligation 與 changed region。
 *
 * @param {unknown} obligations - Adapter coverage obligation 集合。
 * @param {Map<string, object>} adapters - 已宣告的 adapter descriptor。
 * @returns {string[]} 穩定錯誤碼。
 */
function validateObligations(obligations, adapters) {
  if (!Array.isArray(obligations) || obligations.length === 0) return ['ADAPTER_OBLIGATIONS_MISSING'];

  const errors = [];
  const ids = obligations.map((obligation) => obligation?.id);
  if (new Set(ids).size !== ids.length) errors.push('ADAPTER_OBLIGATION_DUPLICATE_ID');

  for (const obligation of obligations) {
    const id = typeof obligation?.id === 'string' && obligation.id.trim() !== '' ? obligation.id : 'unknown';
    if (id === 'unknown') errors.push('ADAPTER_OBLIGATION_ID_MISSING');
    if (!ADAPTER_STATUSES.includes(obligation?.status)) errors.push(`ADAPTER_STATUS_INVALID:${id}`);
    if (typeof obligation?.required !== 'boolean') errors.push(`ADAPTER_REQUIRED_INVALID:${id}`);
    if (!Array.isArray(obligation?.changedRegions)) {
      errors.push(`ADAPTER_CHANGED_REGIONS_MISSING:${id}`);
      continue;
    }
    if (obligation.required === true && obligation.status === 'COMPLETE' && obligation.changedRegions.length === 0) {
      errors.push(`ADAPTER_REQUIRED_REGIONS_MISSING:${id}`);
    }

    const rangesByPath = new Map();
    for (const region of obligation.changedRegions) {
      const validRange = Number.isInteger(region?.startByte)
        && Number.isInteger(region?.endByte)
        && region.startByte >= 0
        && region.endByte > region.startByte;
      if (!validRange) errors.push(`REGION_RANGE_INVALID:${id}`);
      if (typeof region?.path !== 'string' || region.path.trim() === '') errors.push(`REGION_PATH_MISSING:${id}`);
      if (typeof region?.language !== 'string' || region.language.trim() === '') errors.push(`REGION_LANGUAGE_MISSING:${id}`);
      if (typeof region?.adapterId !== 'string' || region.adapterId.trim() === '') {
        errors.push(`REGION_ADAPTER_MISSING:${id}`);
      } else if (!adapters.has(region.adapterId)) {
        errors.push(`REGION_ADAPTER_UNDECLARED:${region.adapterId}`);
      } else if (
        typeof region.language === 'string'
        && region.language.trim() !== ''
        && !adapters.get(region.adapterId).languages.includes(region.language)
      ) {
        errors.push(`REGION_LANGUAGE_UNSUPPORTED:${region.adapterId}:${region.language}`);
      }
      const runtimeContext = canonicalRuntimeContext(region?.runtimeContext);
      if (!runtimeContext) {
        errors.push(`REGION_RUNTIME_CONTEXT_INVALID:${id}`);
      } else if (
        runtimeContext.namespace !== 'unknown'
        && !runtimeContext.id.startsWith(`${runtimeContext.namespace}:`)
      ) {
        errors.push(`REGION_RUNTIME_NAMESPACE_MISMATCH:${id}`);
      }

      if (validRange && typeof region?.path === 'string') {
        const ranges = rangesByPath.get(region.path) ?? [];
        ranges.push({ startByte: region.startByte, endByte: region.endByte });
        rangesByPath.set(region.path, ranges);
      }
    }

    for (const ranges of rangesByPath.values()) {
      ranges.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
      for (let index = 1; index < ranges.length; index += 1) {
        if (ranges[index].startByte < ranges[index - 1].endByte) {
          errors.push(`REGION_OVERLAP:${id}`);
          break;
        }
      }
    }
  }

  return stableStrings(errors);
}

/**
 * 驗證 AdapterResult 的字串清單欄位。
 *
 * @param {unknown} value - 欄位值。
 * @param {string} field - error code 使用的欄位名稱。
 * @returns {string[]} 穩定錯誤碼。
 */
function validateResultStringList(value, field) {
  if (!Array.isArray(value)) return [`ADAPTER_${field}_MISSING`];

  const errors = [];
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`ADAPTER_${field}_INVALID`);
  }
  if (new Set(value).size !== value.length) errors.push(`ADAPTER_${field}_DUPLICATE`);
  return errors;
}

/**
 * 驗證 AdapterResult 完整性欄位與 required terminal status 的一致性。
 *
 * @param {unknown} result - AdapterResult。
 * @returns {string[]} 穩定錯誤碼。
 */
function validateResultCompleteness(result) {
  const errors = [];
  if (typeof result?.complete !== 'boolean') {
    errors.push('ADAPTER_COMPLETE_INVALID');
    return errors;
  }

  const hasReasonCode = typeof result.reasonCode === 'string' && result.reasonCode.trim() !== '';
  if (!result.complete && !hasReasonCode) errors.push('ADAPTER_REASON_CODE_MISSING');
  if (result.complete && result.reasonCode !== undefined) errors.push('ADAPTER_REASON_CODE_UNEXPECTED');

  if (result.complete && Array.isArray(result.obligations)) {
    for (const obligation of result.obligations) {
      if (obligation?.required === true && obligation.status !== 'COMPLETE') {
        errors.push(`ADAPTER_COMPLETE_STATUS_MISMATCH:${obligation?.id ?? 'unknown'}`);
      }
    }
  }
  return errors;
}

/**
 * 驗證 Adapter 回傳的 normalized facts contract。
 *
 * @param {unknown} result - Adapter result。
 * @returns {{valid: boolean, errors: string[]}} 驗證結果。
 */
export function validateAdapterResult(result) {
  const adapterSetErrors = validateAdapterSet(result?.adapterSet);
  const adapters = new Map(
    Array.isArray(result?.adapterSet)
      ? result.adapterSet
        .filter((adapter) => typeof adapter?.id === 'string' && Array.isArray(adapter.languages))
        .map((adapter) => [adapter.id, adapter])
      : [],
  );
  const errors = stableStrings([
    ...adapterSetErrors,
    ...validateObligations(result?.obligations, adapters),
    ...validateResultStringList(result?.diagnostics, 'DIAGNOSTICS'),
    ...validateResultStringList(result?.evidenceReferences, 'EVIDENCE_REFERENCES'),
    ...validateSemanticFacts(result?.facts, result?.adapterSet).errors,
    ...validateResultCompleteness(result),
  ]);

  return { valid: errors.length === 0, errors };
}

/**
 * 建立可由 canonical AdapterSet 與 region runtime context 重算的 binding。
 *
 * @param {object} result - 已驗證的 Adapter result。
 * @returns {{adapterSet: object[], adapterSetDigest: string, executionContextDigest: string, regions: object[]}} context binding。
 */
export function createAnalysisContextBinding(result) {
  const validation = validateAdapterResult(result);
  if (!validation.valid) {
    throw new Error(`ADAPTER_RESULT_INVALID:${validation.errors.join(',')}`);
  }

  const adapterSet = [...result.adapterSet]
    .map((adapter) => ({
      capabilities: [...adapter.capabilities].sort(compareText),
      id: adapter.id,
      languages: [...adapter.languages].sort(compareText),
      version: adapter.version,
    }))
    .sort((left, right) => compareText(left.id, right.id));
  const adapterIdentity = adapterSet.map(({ id, version }) => ({ id, version }));
  const regions = result.obligations.flatMap((obligation) => obligation.changedRegions.map((region) => ({
    adapterId: region.adapterId,
    endByte: region.endByte,
    language: region.language,
    path: region.path,
    runtimeContext: canonicalRuntimeContext(region.runtimeContext),
    startByte: region.startByte,
  }))).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));

  return {
    adapterSet,
    adapterSetDigest: digest(adapterIdentity),
    executionContextDigest: digest(regions),
    regions,
  };
}

/**
 * 驗證 candidate/summary 使用的 analysis context binding。
 *
 * @param {unknown} binding - 要驗證的 context binding。
 * @returns {{valid: boolean, errors: string[]}} 驗證結果。
 */
export function validateAnalysisContextBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    return { valid: false, errors: ['ANALYSIS_CONTEXT_BINDING_MISSING'] };
  }

  const errors = validateAdapterResult({
    adapterSet: binding.adapterSet,
    obligations: [{
      id: 'CONTEXT-BINDING',
      required: false,
      status: 'COMPLETE',
      changedRegions: binding.regions,
    }],
    complete: true,
    diagnostics: [],
    evidenceReferences: [],
    facts: [],
  }).errors;
  const adapterIdentity = Array.isArray(binding.adapterSet)
    ? binding.adapterSet.map((adapter) => ({ id: adapter?.id, version: adapter?.version }))
    : binding.adapterSet;
  if (
    typeof binding.adapterSetDigest !== 'string'
    || binding.adapterSetDigest !== digest(adapterIdentity)
  ) {
    errors.push('ADAPTER_SET_DIGEST_MISMATCH');
  }
  if (
    typeof binding.executionContextDigest !== 'string'
    || binding.executionContextDigest !== digest(binding.regions)
  ) {
    errors.push('EXECUTION_CONTEXT_DIGEST_MISMATCH');
  }

  const stableErrors = stableStrings(errors);
  return { valid: stableErrors.length === 0, errors: stableErrors };
}

/**
 * 比較兩個已驗證 context binding 是否完全一致。
 *
 * @param {object|undefined} left - 第一個 context binding。
 * @param {object|undefined} right - 第二個 context binding。
 * @returns {boolean} 是否為相同 binding。
 */
export function sameAnalysisContextBinding(left, right) {
  const leftValidation = validateAnalysisContextBinding(left);
  const rightValidation = validateAnalysisContextBinding(right);
  return leftValidation.valid
    && rightValidation.valid
    && left.adapterSetDigest === right.adapterSetDigest
    && left.executionContextDigest === right.executionContextDigest;
}
