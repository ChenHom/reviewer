export const ADAPTER_FAILURE_CODES = Object.freeze([
  'ADAPTER_EXECUTION_TIMEOUT',
  'ADAPTER_EXCEPTION',
  'ADAPTER_RESULT_INVALID',
  'ADAPTER_ABORTED',
]);

/**
 * 建立不包含 exception object 或 stack trace 的 Adapter failure input。
 *
 * @param {object|null|undefined} identity - 分析要求使用的 AnalysisIdentity。
 * @param {string} code - stable Adapter failure code。
 * @returns {{identity: object|null, analysisError: string, diagnostics: string[]}} failure input。
 */
export function createAdapterFailureInput(identity, code) {
  const failureCode = ADAPTER_FAILURE_CODES.includes(code)
    ? code
    : 'ADAPTER_RESULT_INVALID';
  return {
    identity: identity ?? null,
    analysisError: failureCode,
    diagnostics: [failureCode],
  };
}
