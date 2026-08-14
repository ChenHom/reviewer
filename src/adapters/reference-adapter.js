import { stableStrings } from '../contracts.js';
import { validateAdapterResult } from './contracts.js';

/**
 * 建立 JSON deep clone，避免 reference adapter 暴露 fixture 的可變物件。
 *
 * @param {object} value - 要複製的 JSON-compatible value。
 * @returns {object} 複製後的 value。
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 將 fixture result 轉成 Adapter 宣告的 terminal timeout result。
 *
 * @param {object} result - 已驗證的 AdapterResult。
 * @returns {object} timeout AdapterResult。
 */
function timeoutResult(result) {
  return {
    ...clone(result),
    obligations: result.obligations.map((obligation) => ({
      ...clone(obligation),
      status: 'TIMEOUT',
      changedRegions: [],
    })),
    diagnostics: stableStrings([...result.diagnostics, 'TIMEOUT']),
    complete: false,
    reasonCode: 'TIMEOUT',
  };
}

/**
 * 建立只讀 fixture-backed 的 deterministic reference adapter。
 *
 * @param {object} fixture - 含 AdapterResult 的 deterministic fixture。
 * @returns {{descriptor: object, analyze: function}} adapter descriptor 與 analyze 入口。
 */
export function createReferenceAdapter(fixture) {
  const result = fixture?.adapterResult ?? fixture;
  const validation = validateAdapterResult(result);
  if (!validation.valid) {
    throw new Error(`ADAPTER_RESULT_INVALID:${validation.errors.join(',')}`);
  }

  const descriptor = clone(result.adapterSet[0]);
  return {
    descriptor,
    async analyze(request = {}, options = {}) {
      if (options.signal?.aborted) return timeoutResult(result);
      return clone(result);
    },
  };
}
