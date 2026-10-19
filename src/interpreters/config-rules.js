/**
 * 專案設定（`.reviewer.json` 的 `rules`）的規則引擎 interpreter。
 *
 * 規則只比對 fact schema v2 的結構化欄位，所以同一份規則可用於任何語言的 adapter：
 *
 * - `sensitiveOperands`：`BINARY_OPERATOR_CHANGED` 的運算式符合 pattern → `SENSITIVE_OPERAND_CHANGED`。
 * - `protectedCalls`：`CALL_REMOVED` → `PROTECTED_CALL_REMOVED`。
 * - `sideEffectCalls`：`CALL_ADDED` → `SIDE_EFFECT_CALL_ADDED`。
 * - `protectedArguments`：參數被改變、移除或新增（`CALL_ARGUMENT_*`、container 為該參數的值變更 fact、
 *   位置參數的 `CALL_ARGUMENTS_REORDERED`）→ `PROTECTED_ARGUMENT_CHANGED`（或規則指定的 blocker）。
 *
 * 沒有規則命中時回傳 `handled: false`，fact 照常由其他 interpreter 處理或成為 `FACT_UNHANDLED`。
 * Interpreter version 帶設定內容的 digest，所以設定不同時 `interpreterSetDigest` 也不同。
 */
import { stringMatcher } from '../config/matchers.js';
import { structuredCallee, structuredContainer } from '../facts/structured.js';
import { operatorCategory } from './core.js';

export const CONFIG_RULES_ENGINE_VERSION = '1.1.0';

/**
 * 呼叫規則（`{ name?, receiver? }`）的比對函式。`receiver` 含 `.` 時比對以 `.` 連接的完整路徑，
 * 否則比對最後一段；`/regex/` 一律比對最後一段。
 *
 * @param {{name?: string, receiver?: string}} rule - 規則。
 * @returns {function(object): boolean} callee 比對函式。
 */
function callMatcher(rule) {
  const name = rule.name === undefined ? () => true : stringMatcher(rule.name);
  let receiver = () => true;
  if (rule.receiver !== undefined) {
    const match = stringMatcher(rule.receiver);
    const fullPath = !rule.receiver.startsWith('/') && rule.receiver.includes('.');
    receiver = (callee) => Array.isArray(callee.receiver)
      && callee.receiver.length > 0
      && match(fullPath ? callee.receiver.join('.') : callee.receiver.at(-1));
  }
  return (callee) => name(callee.name) && receiver(callee);
}

/**
 * `protectedArguments` 命中的 blocker。參數的改變有三種 fact：
 *
 * - `CALL_ARGUMENT_CHANGED` / `REMOVED` / `ADDED`：`properties.callee` 與 `properties.argument`；
 * - 參數內的值改變（`charge(100)` → `charge(1000)` 的 `LITERAL_CHANGED`，以及 `VARIABLE_CHANGED`、
 *   `BINARY_OPERATOR_CHANGED`、`EXPRESSION_NEGATED`、`ARRAY_ITEM_*` 等）：`properties.container` 為該參數
 *   （`type: argument`；`keys` 不為空時是參數中的巢狀值，同樣算參數改變）；
 * - `CALL_ARGUMENTS_REORDERED`：位置參數的值換了位置（具名參數不受順序影響）。
 *
 * @param {object} fact - semantic fact。
 * @param {object[]} rules - 編譯後的 protectedArguments 規則。
 * @returns {string[]} blocker。
 */
function protectedArgumentBlockers(fact, rules) {
  if (rules.length === 0) return [];
  const properties = fact?.properties ?? {};
  const matching = (callee, argumentMatches) => rules.filter((rule) => rule.callee(callee) && argumentMatches(rule)).map((rule) => rule.blocker);

  const callee = structuredCallee(properties.callee);
  if (callee && ['CALL_ARGUMENT_CHANGED', 'CALL_ARGUMENT_REMOVED', 'CALL_ARGUMENT_ADDED'].includes(fact.kind)) {
    return matching(callee, (rule) => rule.argument(properties.argument));
  }
  if (callee && fact.kind === 'CALL_ARGUMENTS_REORDERED') {
    return matching(callee, (rule) => rule.positional);
  }
  const container = structuredContainer(properties.container);
  const owner = structuredCallee(container?.callee);
  if (container?.type === 'argument' && owner) {
    return matching(owner, (rule) => rule.argument(container.argument));
  }
  return [];
}

/**
 * 建立規則引擎 interpreter。
 *
 * @param {object} rules - 已驗證的 `rules`。
 * @param {string} digest - 設定內容的 sha256。
 * @returns {object} interpreter descriptor。
 */
export function createConfigRulesInterpreter(rules, digest) {
  const sensitive = rules.sensitiveOperands.map((rule) => ({
    matches: stringMatcher(rule.pattern),
    operators: rule.operators ?? 'any',
  }));
  const protectedCalls = rules.protectedCalls.map(callMatcher);
  const sideEffects = rules.sideEffectCalls.map(callMatcher);
  const protectedArguments = rules.protectedArguments.map((rule) => ({
    callee: callMatcher(rule),
    argument: typeof rule.argument === 'number'
      ? (value) => value === rule.argument
      : ((matches) => (value) => typeof value === 'string' && matches(value))(stringMatcher(rule.argument)),
    positional: typeof rule.argument === 'number',
    blocker: rule.blocker ?? 'PROTECTED_ARGUMENT_CHANGED',
  }));

  const handled = (blockers) => (blockers.length > 0 ? { handled: true, blockers: [...new Set(blockers)] } : { handled: false });

  return Object.freeze({
    id: 'config-rules',
    version: `${CONFIG_RULES_ENGINE_VERSION}+${digest.slice(0, 16)}`,
    interpret(fact) {
      const properties = fact?.properties ?? {};
      const blockers = [];

      if (fact?.kind === 'BINARY_OPERATOR_CHANGED') {
        const operators = [operatorCategory(properties.operatorBefore), operatorCategory(properties.operatorAfter)];
        const expressions = [properties.before, properties.after].filter((value) => typeof value === 'string');
        const hit = sensitive.some((rule) => (rule.operators === 'any' || operators.includes(rule.operators))
          && expressions.some((expression) => rule.matches(expression)));
        if (hit) blockers.push('SENSITIVE_OPERAND_CHANGED');
      }

      const callee = structuredCallee(properties.callee);
      if (fact?.kind === 'CALL_REMOVED' && callee && protectedCalls.some((matches) => matches(callee))) {
        blockers.push('PROTECTED_CALL_REMOVED');
      }
      if (fact?.kind === 'CALL_ADDED' && callee && sideEffects.some((matches) => matches(callee))) {
        blockers.push('SIDE_EFFECT_CALL_ADDED');
      }
      blockers.push(...protectedArgumentBlockers(fact, protectedArguments));
      return handled(blockers);
    },
  });
}
