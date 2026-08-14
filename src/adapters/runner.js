import { validateAdapterResult } from './contracts.js';
import { createAdapterFailureInput } from './errors.js';

const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

/**
 * 建立 execution failure outcome。
 *
 * @param {object|null|undefined} identity - 分析要求使用的 AnalysisIdentity。
 * @param {string} code - stable Adapter failure code。
 * @returns {{ok: false, identity: object|null, code: string, input: object}} failure outcome。
 */
function failureOutcome(identity, code) {
  return {
    ok: false,
    identity: identity ?? null,
    code,
    input: createAdapterFailureInput(identity, code),
  };
}

/**
 * 執行 Adapter 並以 deadline、AbortSignal、exception 與 result validation 建立安全邊界。
 *
 * @param {{analyze: function}} adapter - injected Adapter implementation。
 * @param {object} [request={}] - Adapter request，至少可包含 identity。
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options={}] - execution options。
 * @returns {Promise<{ok: true, identity: object|null, adapterResult: object}|{ok: false, identity: object|null, code: string, input: object}>} execution outcome。
 */
export async function runAdapter(adapter, request = {}, options = {}) {
  const identity = request?.identity ?? null;
  const parentSignal = options.signal;

  if (parentSignal?.aborted) return failureOutcome(identity, 'ADAPTER_ABORTED');
  if (!adapter || typeof adapter.analyze !== 'function') {
    return failureOutcome(identity, 'ADAPTER_RESULT_INVALID');
  }

  const controller = new globalThis.AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : DEFAULT_ADAPTER_TIMEOUT_MS;
  let timeoutId;
  let parentAbortHandler;

  const adapterPromise = Promise.resolve().then(() => adapter.analyze(request, {
    signal: controller.signal,
  })).then(
    (value) => ({ kind: 'result', value }),
    (error) => ({ kind: 'exception', error }),
  );

  const parentAbortPromise = new Promise((resolve) => {
    if (!parentSignal || typeof parentSignal.addEventListener !== 'function') return;
    parentAbortHandler = () => {
      controller.abort();
      resolve({ kind: 'aborted' });
    };
    parentSignal.addEventListener('abort', parentAbortHandler, { once: true });
  });

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = globalThis.setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });

  const outcome = await Promise.race([adapterPromise, parentAbortPromise, timeoutPromise]);
  globalThis.clearTimeout(timeoutId);
  if (parentSignal && parentAbortHandler) {
    parentSignal.removeEventListener('abort', parentAbortHandler);
  }

  if (outcome.kind === 'timeout') return failureOutcome(identity, 'ADAPTER_EXECUTION_TIMEOUT');
  if (outcome.kind === 'aborted') return failureOutcome(identity, 'ADAPTER_ABORTED');
  if (outcome.kind === 'exception') return failureOutcome(identity, 'ADAPTER_EXCEPTION');

  const validation = validateAdapterResult(outcome.value);
  if (!validation.valid) return failureOutcome(identity, 'ADAPTER_RESULT_INVALID');

  return {
    ok: true,
    identity,
    adapterResult: outcome.value,
  };
}
