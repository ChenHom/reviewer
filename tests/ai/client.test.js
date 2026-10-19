import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicReviewer, errorCode, parseResponse } from '../../src/ai/client.js';
import { AI_OUTPUT_SCHEMA, validateAiOutput } from '../../src/ai/schema.js';

const output = (overrides = {}) => ({
  verdict: 'PASS',
  summary: '沒有問題',
  concerns: [],
  fix: { description: '', edits: [] },
  flowchart: '',
  ...overrides,
});
const message = (body, extra = {}) => ({
  model: DEFAULT_MODEL,
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  ...extra,
});

/**
 * 假的 Anthropic client：記錄請求，回傳指定的回應或丟出錯誤。
 *
 * @param {function(object): object} respond - 依請求回傳 BetaMessage（或丟出錯誤）。
 * @returns {{client: object, requests: object[]}} client 與請求紀錄。
 */
function fakeClient(respond) {
  const requests = [];
  return {
    requests,
    client: {
      beta: {
        messages: {
          stream(params) {
            requests.push(params);
            return { finalMessage: async () => respond(params) };
          },
        },
      },
    },
  };
}

test('請求使用 structured outputs、明確的 effort 與 server-side fallback，system 原樣傳入', async () => {
  const { client, requests } = fakeClient(() => message(output()));
  const reviewer = await createAnthropicReviewer({ client });
  assert.equal(reviewer.model, 'claude-opus-5-5');
  assert.equal(reviewer.effort, DEFAULT_EFFORT);
  const system = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }];
  const result = await reviewer.review({ system, message: 'review this' });

  assert.deepEqual(result, {
    ok: true,
    output: output(),
    model: DEFAULT_MODEL,
    fallback: false,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
  });
  const [request] = requests;
  assert.equal(request.model, DEFAULT_MODEL);
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.output_config, { effort: 'high', format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } });
  assert.equal(request.thinking, undefined);
  assert.ok(request.max_tokens >= 16_000);
  assert.equal(request.system, system);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'review this' }]);

  const custom = await createAnthropicReviewer({ client, model: 'claude-sonnet-5-5', effort: 'medium' });
  await custom.review({ system, message: 'x' });
  assert.equal(requests[1].model, 'claude-sonnet-5-5');
  assert.equal(requests[1].output_config.effort, 'medium');
});

test('備援模型回答時標示 fallback 與實際模型', async () => {
  const { client } = fakeClient(() => message(output(), {
    model: 'claude-opus-4-8',
    usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
  }));
  const result = await (await createAnthropicReviewer({ client })).review({ system: [], message: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.model, 'claude-opus-4-8');
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
});

test('拒絕、截斷、沒有文字、不是 JSON、格式錯誤都是失敗', () => {
  assert.deepEqual(parseResponse(message(output(), { stop_reason: 'refusal', stop_details: { category: 'cyber' } })), { ok: false, error: 'AI_REFUSED:cyber' });
  assert.deepEqual(parseResponse(message(output(), { stop_reason: 'refusal', stop_details: null })), { ok: false, error: 'AI_REFUSED' });
  assert.deepEqual(parseResponse(message(output(), { stop_reason: 'max_tokens' })), { ok: false, error: 'AI_OUTPUT_TRUNCATED' });
  assert.deepEqual(parseResponse({ stop_reason: 'end_turn', content: [] }), { ok: false, error: 'AI_OUTPUT_EMPTY' });
  assert.deepEqual(parseResponse(undefined), { ok: false, error: 'AI_OUTPUT_EMPTY' });
  assert.deepEqual(parseResponse(message('not json')), { ok: false, error: 'AI_OUTPUT_NOT_JSON' });
  assert.deepEqual(parseResponse(message({ verdict: 'PASS' })), { ok: false, error: 'AI_OUTPUT_INVALID:AI_OUTPUT_SHAPE' });
  assert.deepEqual(parseResponse(message(output({ verdict: 'MAYBE' }))), { ok: false, error: 'AI_OUTPUT_INVALID:AI_OUTPUT_VERDICT' });
});

test('輸出驗證：concern、fix、長度與多餘欄位', () => {
  const concern = { title: 't', detail: 'd', severity: 'high', side: 'head', startLine: 3, endLine: 4, standard: '' };
  assert.deepEqual(validateAiOutput(output({ concerns: [concern] })), { valid: true, errors: [] });
  assert.deepEqual(validateAiOutput(output({ fix: { description: 'd', edits: [{ oldText: 'a', newText: 'b' }] } })), { valid: true, errors: [] });
  const invalid = [
    [output({ concerns: [{ ...concern, severity: 'critical' }] }), 'AI_OUTPUT_CONCERNS'],
    [output({ concerns: [{ ...concern, startLine: 5, endLine: 4 }] }), 'AI_OUTPUT_CONCERNS'],
    [output({ concerns: [{ ...concern, startLine: -1 }] }), 'AI_OUTPUT_CONCERNS'],
    [output({ concerns: [{ ...concern, title: ' ' }] }), 'AI_OUTPUT_CONCERNS'],
    [output({ concerns: [{ ...concern, extra: 1 }] }), 'AI_OUTPUT_CONCERNS'],
    [output({ concerns: 'none' }), 'AI_OUTPUT_CONCERNS'],
    [output({ fix: null }), 'AI_OUTPUT_FIX'],
    [output({ fix: { description: 'd', edits: [{ oldText: 1, newText: 'b' }] } }), 'AI_OUTPUT_FIX'],
    [output({ summary: 'x'.repeat(5_000) }), 'AI_OUTPUT_SUMMARY'],
    [output({ flowchart: null }), 'AI_OUTPUT_FLOWCHART'],
  ];
  for (const [value, error] of invalid) assert.deepEqual(validateAiOutput(value), { valid: false, errors: [error] }, error);
  assert.deepEqual(validateAiOutput([]), { valid: false, errors: ['AI_OUTPUT_SHAPE'] });
  assert.deepEqual(validateAiOutput({ ...output(), extra: true }), { valid: false, errors: ['AI_OUTPUT_SHAPE'] });
});

test('API 錯誤依 SDK 的錯誤類別分類，請求失敗時回傳失敗而不是丟出', async () => {
  const sdk = await import('@anthropic-ai/sdk');
  const errorOf = (Type, status) => Object.assign(Object.create(Type.prototype), { status });
  assert.equal(errorCode(sdk, errorOf(sdk.AuthenticationError, 401)), 'AI_AUTHENTICATION_FAILED');
  assert.equal(errorCode(sdk, errorOf(sdk.PermissionDeniedError, 403)), 'AI_PERMISSION_DENIED');
  assert.equal(errorCode(sdk, errorOf(sdk.RateLimitError, 429)), 'AI_RATE_LIMITED');
  assert.equal(errorCode(sdk, errorOf(sdk.BadRequestError, 400)), 'AI_BAD_REQUEST');
  assert.equal(errorCode(sdk, errorOf(sdk.APIConnectionError)), 'AI_CONNECTION_FAILED');
  assert.equal(errorCode(sdk, errorOf(sdk.InternalServerError, 529)), 'AI_API_ERROR:529');
  assert.equal(errorCode(sdk, errorOf(sdk.APIError)), 'AI_API_ERROR:unknown');
  assert.equal(errorCode(sdk, new Error('boom')), 'AI_REQUEST_FAILED');
  assert.equal(errorCode(null, new Error('boom')), 'AI_REQUEST_FAILED');

  const { client } = fakeClient(() => {
    throw errorOf(sdk.RateLimitError, 429);
  });
  const result = await (await createAnthropicReviewer({ client, sdk })).review({ system: [], message: 'x' });
  assert.deepEqual(result, {
    ok: false,
    error: 'AI_RATE_LIMITED',
    model: DEFAULT_MODEL,
    fallback: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  });
});

test('沒有 API key、effort 無效時在呼叫 API 之前失敗；有 key 時建立 SDK client', async () => {
  await assert.rejects(createAnthropicReviewer({ env: {} }), /AI_NOT_CONFIGURED/);
  await assert.rejects(createAnthropicReviewer({ effort: 'extreme', env: { ANTHROPIC_API_KEY: 'k' } }), /AI_EFFORT_INVALID:extreme/);
  const reviewer = await createAnthropicReviewer({ env: { ANTHROPIC_API_KEY: 'test-key' } });
  assert.equal(typeof reviewer.review, 'function');
});
