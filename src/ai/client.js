/**
 * 以 Anthropic Messages API 執行第 2 層（AI）審查。
 *
 * - `@anthropic-ai/sdk` 只在啟用 AI 審查時才載入：不使用 AI 時 CLI 不需要安裝任何 runtime 依賴。
 * - 預設啟用 server-side fallback（`fallbacks: 'default'`）：主要模型拒絕回答時，由 API 在同一個請求中
 *   改用 Anthropic 建議的備援模型。最後仍拒絕、輸出被截斷或格式不符時，該檔案的 AI 結果為失敗（交給人工）。
 * - 以 streaming 取得完整回應，避免大檔案的請求逾時。
 */
import process from 'node:process';

import { AI_OUTPUT_SCHEMA, validateAiOutput } from './schema.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'high';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_TOKENS = 32_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * 載入 SDK；沒有安裝時丟出 `AI_SDK_MISSING`。
 *
 * @returns {Promise<object>} SDK module。
 */
async function loadSdk() {
  try {
    return await import('@anthropic-ai/sdk');
  } catch {
    throw new Error('AI_SDK_MISSING:@anthropic-ai/sdk 未安裝，請在 Reviewer 目錄執行 npm ci');
  }
}

/**
 * API 錯誤對應的失敗代碼（以 SDK 的錯誤類別判斷，不比對訊息文字）。
 *
 * @param {object} sdk - SDK module。
 * @param {unknown} error - 錯誤。
 * @returns {string} 失敗代碼。
 */
export function errorCode(sdk, error) {
  if (sdk && error instanceof sdk.AuthenticationError) return 'AI_AUTHENTICATION_FAILED';
  if (sdk && error instanceof sdk.PermissionDeniedError) return 'AI_PERMISSION_DENIED';
  if (sdk && error instanceof sdk.RateLimitError) return 'AI_RATE_LIMITED';
  if (sdk && error instanceof sdk.BadRequestError) return 'AI_BAD_REQUEST';
  if (sdk && error instanceof sdk.APIConnectionError) return 'AI_CONNECTION_FAILED';
  if (sdk && error instanceof sdk.APIError) return `AI_API_ERROR:${error.status ?? 'unknown'}`;
  return 'AI_REQUEST_FAILED';
}

/**
 * 回應的 token 用量（含 prompt cache）。
 *
 * @param {object|undefined} usage - response.usage。
 * @returns {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number}} 用量。
 */
function usageOf(usage) {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * 解讀 API 回應：拒絕、截斷、沒有文字、JSON 或格式錯誤都是失敗。
 *
 * @param {object} response - BetaMessage。
 * @param {function(unknown): {valid: boolean, errors: string[]}} [validate=validateAiOutput] - 輸出驗證。
 * @returns {{ok: true, output: object}|{ok: false, error: string}} 結果。
 */
export function parseResponse(response, validate = validateAiOutput) {
  if (response?.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    return { ok: false, error: `AI_REFUSED${category ? `:${category}` : ''}` };
  }
  if (response?.stop_reason === 'max_tokens') return { ok: false, error: 'AI_OUTPUT_TRUNCATED' };
  const text = (response?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
  if (text.trim() === '') return { ok: false, error: 'AI_OUTPUT_EMPTY' };
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return { ok: false, error: 'AI_OUTPUT_NOT_JSON' };
  }
  const validation = validate(output);
  return validation.valid ? { ok: true, output } : { ok: false, error: `AI_OUTPUT_INVALID:${validation.errors.join(',')}` };
}

/**
 * 建立 AI reviewer。
 *
 * @param {object} [options={}] - 選項。
 * @param {string} [options.model=DEFAULT_MODEL] - 模型 id。
 * @param {string} [options.effort=DEFAULT_EFFORT] - `low` | `medium` | `high` | `xhigh` | `max`。
 * @param {object} [options.client] - 已建立的 client（測試用；需提供 `beta.messages.stream()`）。
 * @param {object} [options.sdk] - SDK module（測試用，錯誤分類用）。
 * @param {object} [options.env=process.env] - 環境變數。
 * @returns {Promise<{model: string, effort: string, review: function(object): Promise<object>}>} reviewer。
 * @throws {Error} `AI_EFFORT_INVALID`、`AI_NOT_CONFIGURED`、`AI_SDK_MISSING`。
 */
export async function createAnthropicReviewer({ model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, client, sdk, env = process.env } = {}) {
  if (!EFFORTS.includes(effort)) throw new Error(`AI_EFFORT_INVALID:${effort}`);
  let api = client;
  let module = sdk ?? null;
  if (!api) {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error('AI_NOT_CONFIGURED:請設定 ANTHROPIC_API_KEY');
    }
    module = await loadSdk();
    api = new module.default();
  }

  return {
    model,
    effort,
    /**
     * 送出一個請求（預設為檔案審查的輸出格式；retro 以 `schema` / `validate` 指定自己的格式）。
     *
     * @param {object} request - prompt。
     * @param {object[]} request.system - system content blocks。
     * @param {string} request.message - user message。
     * @param {object} [request.schema=AI_OUTPUT_SCHEMA] - 輸出的 JSON schema。
     * @param {function(unknown): {valid: boolean, errors: string[]}} [request.validate=validateAiOutput] - 輸出驗證。
     * @returns {Promise<object>} `{ ok, output?, error?, model, fallback, usage }`。
     */
    async review({ system, message, schema = AI_OUTPUT_SCHEMA, validate = validateAiOutput }) {
      let response;
      try {
        response = await api.beta.messages.stream({
          model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort, format: { type: 'json_schema', schema } },
          system,
          messages: [{ role: 'user', content: message }],
        }).finalMessage();
      } catch (error) {
        return { ok: false, error: errorCode(module, error), model, fallback: false, usage: usageOf(undefined) };
      }
      const fallback = (response?.usage?.iterations ?? []).some((entry) => entry?.type === 'fallback_message');
      return { ...parseResponse(response, validate), model: response?.model ?? model, fallback, usage: usageOf(response?.usage) };
    },
  };
}
