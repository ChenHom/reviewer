import { createAnalysisContextBinding, validateAdapterResult } from './contracts.js';

const coverageStatusByAdapterStatus = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL_PARSE: 'INCOMPLETE',
  UNSUPPORTED: 'INCOMPLETE',
  TIMEOUT: 'INCOMPLETE',
  TRUNCATED: 'INCOMPLETE',
  FAILED: 'FAILED',
});

/**
 * 使用 deterministic bytewise 順序比較文字。
 *
 * @param {string} left - 左側文字。
 * @param {string} right - 右側文字。
 * @returns {number} 排序結果。
 */
function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 對 changed region 進行 path、byte range 與 ownership 的穩定排序。
 *
 * @param {object} left - 左側 region。
 * @param {object} right - 右側 region。
 * @returns {number} 排序結果。
 */
function compareRegions(left, right) {
  return compareText(left.path, right.path)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || compareText(left.language, right.language)
    || compareText(left.adapterId, right.adapterId);
}

/**
 * 將 AdapterResult wrapper 解出 AdapterResult 與 AnalysisIdentity。
 *
 * @param {object|undefined} input - AdapterResult 或含 identity 的 wrapper。
 * @returns {{adapterResult: object|undefined, identity: object|null}} 解出的輸入。
 */
function unpackInput(input) {
  if (input?.adapterResult !== undefined) {
    return { adapterResult: input.adapterResult, identity: input.identity ?? null };
  }
  return { adapterResult: input, identity: input?.identity ?? null };
}

/**
 * 將單一 Adapter obligation 映射為 Safety MVP coverage obligation。
 *
 * @param {object} obligation - Adapter obligation。
 * @returns {object} normalized coverage obligation。
 */
function normalizeObligation(obligation) {
  const normalized = {
    id: obligation.id,
    required: obligation.required,
    status: coverageStatusByAdapterStatus[obligation.status],
    changedRegions: [...obligation.changedRegions]
      .map((region) => ({
        path: region.path,
        startByte: region.startByte,
        endByte: region.endByte,
        language: region.language,
        adapterId: region.adapterId,
        runtime: region.runtimeContext.namespace,
      }))
      .sort(compareRegions),
  };

  if (normalized.status !== 'COMPLETE') {
    normalized.reasonCode = obligation.reasonCode ?? obligation.status;
  }

  return normalized;
}

/**
 * 將 AdapterResult 正規化為 runSafetyMvp 可接受的 deterministic input。
 *
 * @param {object|undefined} input - 含 identity 與 adapterResult 的輸入，或 raw AdapterResult。
 * @param {{valid: boolean, errors: string[]}} [validation] - 可重用的 AdapterResult validation 結果。
 * @returns {object} normalized analysis input；輸入無效時只回傳 analysis failure input。
 */
export function normalizeAdapterResult(input, validation = undefined) {
  const { adapterResult, identity } = unpackInput(input);
  const resultValidation = validation ?? validateAdapterResult(adapterResult);

  if (!resultValidation.valid) {
    return {
      identity,
      analysisError: `ADAPTER_RESULT_INVALID:${resultValidation.errors.join(',')}`,
      diagnostics: resultValidation.errors,
    };
  }

  return {
    identity,
    contextBinding: createAnalysisContextBinding(adapterResult),
    coverage: {
      obligations: adapterResult.obligations.map(normalizeObligation),
    },
    riskBlockers: [],
    policyRequirements: [],
    audit: false,
    diagnostics: [...adapterResult.diagnostics],
  };
}
