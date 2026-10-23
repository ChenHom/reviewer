import { createHash } from 'node:crypto';

import { canonicalizeJsonValue } from '../facts/contracts.js';
import { createConfigRulesInterpreter } from '../interpreters/config-rules.js';
import { REGEX_LITERAL, globToRegExp, stringMatcher } from './matchers.js';
import { PRESETS, resolveInterpreters } from '../interpreters/presets/index.js';
import { DEFAULT_ONE_WAY_DOORS } from '../routing.js';

/**
 * 專案設定 `.reviewer.json`（schema version 1）。
 *
 * 設定從 merge base 讀取（PR 不能改寫攔截自己的規則），只能新增 blocker、擴大單向門或
 * 選擇 preset，沒有「忽略」某個 fact 的語法。讀不到時使用預設值；格式錯誤時 fail-closed。
 *
 * ```json
 * {
 *   "version": 1,
 *   "presets": ["php-laravel", "payments"],
 *   "rules": {
 *     "sensitiveOperands": [{ "pattern": "/wallet|balance|amount/i", "operators": "arithmetic" }],
 *     "protectedCalls": [{ "name": "verifySignature" }, { "receiver": "Gate", "name": "authorize" }],
 *     "protectedArguments": [{ "argument": "idempotencyKey", "blocker": "PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED" }],
 *     "sideEffectCalls": [{ "receiver": "Mail", "name": "/^(send|queue)$/" }],
 *     "protectedPaths": ["database/migrations/**"],
 *     "oneWayDoors": ["CONSTANT_VALUE_CHANGED"]
 *   }
 * }
 * ```
 */
export const CONFIG_FILE = '.reviewer.json';

/** 審查規則本身：PR 修改這些檔案時一律是單向門（`POLICY_FILE_CHANGED`）。 */
export const POLICY_FILES = Object.freeze([CONFIG_FILE, 'codingstandards.md']);

/**
 * 預設受保護路徑（`PROTECTED_PATH`）：CI 本身。workflow 能改掉所有檢查、取得 secrets，本地 action 以
 * workflow 的權限執行，AI 不能單獨放行。專案的 `protectedPaths` 只能再增加，不能移除。
 */
export const DEFAULT_PROTECTED_PATHS = Object.freeze(['.github/workflows/**', '.github/actions/**']);

const OPERATOR_GROUPS = ['any', 'arithmetic', 'comparison', 'logical'];
const CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * 是否為 plain object。
 *
 * @param {unknown} value - 值。
 * @returns {boolean} 是否為 plain object。
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 驗證一組物件陣列規則。
 *
 * @param {unknown} list - 規則陣列。
 * @param {string} path - 錯誤訊息中的位置。
 * @param {object} fields - 欄位名稱 → 驗證函式（回傳錯誤代碼或 null）。
 * @param {function(object): string|null} whole - 整筆規則的驗證。
 * @returns {string[]} 錯誤。
 */
function validateRuleList(list, path, fields, whole) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`POLICY_CONFIG_FIELD_INVALID:${path}`];

  const errors = [];
  list.forEach((rule, index) => {
    const at = `${path}[${index}]`;
    if (!isObject(rule)) {
      errors.push(`POLICY_CONFIG_FIELD_INVALID:${at}`);
      return;
    }
    for (const key of Object.keys(rule)) {
      if (!Object.hasOwn(fields, key)) errors.push(`POLICY_CONFIG_KEY_UNKNOWN:${at}.${key}`);
    }
    for (const [key, validate] of Object.entries(fields)) {
      if (rule[key] === undefined) continue;
      const error = validate(rule[key]);
      if (error) errors.push(`${error}:${at}.${key}`);
    }
    const error = whole(rule);
    if (error) errors.push(`${error}:${at}`);
  });
  return errors;
}

/**
 * 驗證比對字串（非空字串，`/regex/` 必須能編譯）。
 *
 * @param {unknown} value - 欄位值。
 * @returns {string|null} 錯誤代碼。
 */
function matcherError(value) {
  if (typeof value !== 'string' || value === '') return 'POLICY_CONFIG_FIELD_INVALID';
  try {
    stringMatcher(value);
  } catch {
    return 'POLICY_CONFIG_REGEX_INVALID';
  }
  return null;
}

/**
 * 驗證 glob 陣列。
 *
 * @param {unknown} list - 欄位值。
 * @param {string} path - 錯誤位置。
 * @returns {string[]} 錯誤。
 */
function globListErrors(list, path) {
  if (list === undefined) return [];
  return Array.isArray(list) && list.every((item) => typeof item === 'string' && item !== '')
    ? []
    : [`POLICY_CONFIG_FIELD_INVALID:${path}`];
}

const callFields = Object.freeze({ name: matcherError, receiver: matcherError });
const needsName = (rule) => (rule.name === undefined && rule.receiver === undefined ? 'POLICY_CONFIG_FIELD_INVALID' : null);

/**
 * 解析並驗證 `.reviewer.json`。任何未知欄位、型別錯誤、無效正規表示式或未知 preset 都使設定無效。
 *
 * @param {string} text - 檔案內容。
 * @returns {{valid: true, config: object, digest: string}|{valid: false, errors: string[]}} 驗證結果。
 */
export function parseProjectConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { valid: false, errors: ['POLICY_CONFIG_PARSE_ERROR'] };
  }
  if (!isObject(raw)) return { valid: false, errors: ['POLICY_CONFIG_FIELD_INVALID:$'] };

  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!['version', 'presets', 'rules'].includes(key)) errors.push(`POLICY_CONFIG_KEY_UNKNOWN:${key}`);
  }
  if (raw.version !== 1) errors.push('POLICY_CONFIG_VERSION_UNSUPPORTED');

  if (raw.presets !== undefined) {
    if (!Array.isArray(raw.presets) || !raw.presets.every((name) => typeof name === 'string')) {
      errors.push('POLICY_CONFIG_FIELD_INVALID:presets');
    } else {
      for (const name of raw.presets) {
        if (!Object.hasOwn(PRESETS, name)) errors.push(`POLICY_CONFIG_PRESET_UNKNOWN:${name}`);
      }
    }
  }

  const rules = raw.rules ?? {};
  if (!isObject(rules)) {
    errors.push('POLICY_CONFIG_FIELD_INVALID:rules');
  } else {
    const ruleKeys = ['sensitiveOperands', 'protectedCalls', 'protectedArguments', 'sideEffectCalls', 'protectedPaths', 'oneWayDoors'];
    for (const key of Object.keys(rules)) {
      if (!ruleKeys.includes(key)) errors.push(`POLICY_CONFIG_KEY_UNKNOWN:rules.${key}`);
    }
    errors.push(
      ...validateRuleList(rules.sensitiveOperands, 'rules.sensitiveOperands', {
        pattern: (value) => (typeof value === 'string' && REGEX_LITERAL.test(value) ? matcherError(value) : 'POLICY_CONFIG_FIELD_INVALID'),
        operators: (value) => (OPERATOR_GROUPS.includes(value) ? null : 'POLICY_CONFIG_FIELD_INVALID'),
      }, (rule) => (rule.pattern === undefined ? 'POLICY_CONFIG_FIELD_INVALID' : null)),
      ...validateRuleList(rules.protectedCalls, 'rules.protectedCalls', callFields, needsName),
      ...validateRuleList(rules.sideEffectCalls, 'rules.sideEffectCalls', callFields, needsName),
      ...validateRuleList(rules.protectedArguments, 'rules.protectedArguments', {
        ...callFields,
        argument: (value) => (Number.isInteger(value) && value >= 0 ? null : matcherError(value)),
        blocker: (value) => (typeof value === 'string' && CODE.test(value) ? null : 'POLICY_CONFIG_FIELD_INVALID'),
      }, (rule) => (rule.argument === undefined ? 'POLICY_CONFIG_FIELD_INVALID' : null)),
      ...globListErrors(rules.protectedPaths, 'rules.protectedPaths'),
    );
    if (
      rules.oneWayDoors !== undefined
      && !(Array.isArray(rules.oneWayDoors) && rules.oneWayDoors.every((code) => typeof code === 'string' && CODE.test(code)))
    ) {
      errors.push('POLICY_CONFIG_FIELD_INVALID:rules.oneWayDoors');
    }
  }

  if (errors.length > 0) return { valid: false, errors: [...new Set(errors)].sort() };

  const config = {
    version: 1,
    presets: raw.presets ?? null,
    rules: {
      sensitiveOperands: rules.sensitiveOperands ?? [],
      protectedCalls: rules.protectedCalls ?? [],
      protectedArguments: rules.protectedArguments ?? [],
      sideEffectCalls: rules.sideEffectCalls ?? [],
      protectedPaths: rules.protectedPaths ?? [],
      oneWayDoors: rules.oneWayDoors ?? [],
    },
  };
  const digest = createHash('sha256').update(JSON.stringify(canonicalizeJsonValue(config))).digest('hex');
  return { valid: true, config, digest };
}

/**
 * 依（已驗證的）專案設定建立審查 policy。沒有設定時為預設值。
 *
 * @param {{config: object, digest: string}|null} parsed - parseProjectConfig() 的有效結果，或 null。
 * @returns {object} policy：`interpretersFor(language)`、`oneWayDoors`、`isProtectedPath(path)`。
 */
export function createProjectPolicy(parsed) {
  const config = parsed?.config ?? null;
  const rules = config?.rules;
  const hasRules = Boolean(rules) && [
    rules.sensitiveOperands, rules.protectedCalls, rules.protectedArguments, rules.sideEffectCalls,
  ].some((list) => list.length > 0);
  const rulesInterpreter = hasRules ? createConfigRulesInterpreter(rules, parsed.digest) : null;
  const protectedPaths = [...DEFAULT_PROTECTED_PATHS, ...(rules?.protectedPaths ?? [])].map(globToRegExp);

  return Object.freeze({
    digest: parsed?.digest ?? null,
    interpretersFor(language) {
      const interpreters = resolveInterpreters(config?.presets ?? language.presets, { language: language.id });
      return rulesInterpreter ? [...interpreters, rulesInterpreter] : interpreters;
    },
    oneWayDoors: Object.freeze([...new Set([
      ...DEFAULT_ONE_WAY_DOORS,
      ...(rules?.oneWayDoors ?? []),
      // 專案自訂的 protectedArguments blocker 也是單向門。
      ...(rules?.protectedArguments ?? []).map((rule) => rule.blocker).filter(Boolean),
    ])]),
    isProtectedPath: (path) => protectedPaths.some((regex) => regex.test(path)),
  });
}
