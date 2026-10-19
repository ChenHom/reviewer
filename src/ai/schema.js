/**
 * 第 2 層（AI）審查的輸出格式：送給 API 的 JSON schema（structured outputs），以及收到後的驗證。
 *
 * structured outputs 已限制輸出形狀，這裡仍逐欄驗證（fail-closed）：任何不符都視為 AI 審查失敗，
 * 交給人工。
 */

export const VERDICTS = Object.freeze(['PASS', 'NEEDS_HUMAN', 'FIX']);
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

const MAX_TEXT = 4_000;
const MAX_CONCERNS = 50;
const MAX_EDITS = 20;
const MAX_EDIT_TEXT = 20_000;
const MAX_FLOWCHART = 8_000;

export const AI_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string' },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          side: { type: 'string', enum: ['head', 'base'] },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          standard: { type: 'string' },
        },
        required: ['title', 'detail', 'severity', 'side', 'startLine', 'endLine', 'standard'],
        additionalProperties: false,
      },
    },
    fix: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['description', 'edits'],
      additionalProperties: false,
    },
    flowchart: { type: 'string' },
  },
  required: ['verdict', 'summary', 'concerns', 'fix', 'flowchart'],
  additionalProperties: false,
});

/**
 * 是否為只含指定 key 的 plain object。
 *
 * @param {unknown} value - 值。
 * @param {string[]} keys - 允許且必須存在的 key。
 * @returns {boolean} 是否符合。
 */
function exactObject(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * 長度受限的字串。
 *
 * @param {unknown} value - 值。
 * @param {number} max - 最大長度。
 * @returns {boolean} 是否符合。
 */
function boundedString(value, max) {
  return typeof value === 'string' && value.length <= max;
}

/**
 * 驗證單一 concern。
 *
 * @param {unknown} concern - concern。
 * @returns {boolean} 是否合法。
 */
function validConcern(concern) {
  return exactObject(concern, ['title', 'detail', 'severity', 'side', 'startLine', 'endLine', 'standard'])
    && boundedString(concern.title, MAX_TEXT) && concern.title.trim() !== ''
    && boundedString(concern.detail, MAX_TEXT)
    && SEVERITIES.includes(concern.severity)
    && ['head', 'base'].includes(concern.side)
    && Number.isInteger(concern.startLine) && concern.startLine >= 0
    && Number.isInteger(concern.endLine) && concern.endLine >= concern.startLine
    && boundedString(concern.standard, MAX_TEXT);
}

/**
 * 驗證 AI 的輸出。
 *
 * @param {unknown} value - JSON.parse 後的輸出。
 * @returns {{valid: boolean, errors: string[]}} 結果。
 */
export function validateAiOutput(value) {
  const errors = [];
  if (!exactObject(value, ['verdict', 'summary', 'concerns', 'fix', 'flowchart'])) {
    return { valid: false, errors: ['AI_OUTPUT_SHAPE'] };
  }
  if (!VERDICTS.includes(value.verdict)) errors.push('AI_OUTPUT_VERDICT');
  if (!boundedString(value.summary, MAX_TEXT)) errors.push('AI_OUTPUT_SUMMARY');
  if (!Array.isArray(value.concerns) || value.concerns.length > MAX_CONCERNS || !value.concerns.every(validConcern)) {
    errors.push('AI_OUTPUT_CONCERNS');
  }
  const { fix } = value;
  if (
    !exactObject(fix, ['description', 'edits'])
    || !boundedString(fix.description, MAX_TEXT)
    || !Array.isArray(fix.edits)
    || fix.edits.length > MAX_EDITS
    || !fix.edits.every((edit) => exactObject(edit, ['oldText', 'newText'])
      && boundedString(edit.oldText, MAX_EDIT_TEXT)
      && boundedString(edit.newText, MAX_EDIT_TEXT))
  ) {
    errors.push('AI_OUTPUT_FIX');
  }
  if (!boundedString(value.flowchart, MAX_FLOWCHART)) errors.push('AI_OUTPUT_FLOWCHART');
  return { valid: errors.length === 0, errors };
}
