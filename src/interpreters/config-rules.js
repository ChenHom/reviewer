/**
 * 專案設定（`.reviewer.json` 的 `rules`）的規則引擎 interpreter。
 *
 * 規則只比對 fact schema v2 的結構化欄位，所以同一份規則可用於任何語言的 adapter：
 *
 * - `sensitiveOperands`：`BINARY_OPERATOR_CHANGED` 的運算式符合 pattern → `SENSITIVE_OPERAND_CHANGED`。
 * - `protectedCalls`：`CALL_REMOVED` → `PROTECTED_CALL_REMOVED`。
 * - `sideEffectCalls`：`CALL_ADDED` → `SIDE_EFFECT_CALL_ADDED`。
 * - `protectedArguments`：`CALL_ARGUMENT_CHANGED` / `REMOVED` / `ADDED` → `PROTECTED_ARGUMENT_CHANGED`（或規則指定的 blocker）。
 *
 * 沒有規則命中時回傳 `handled: false`，fact 照常由其他 interpreter 處理或成為 `FACT_UNHANDLED`。
 * Interpreter version 帶設定內容的 digest，所以設定不同時 `interpreterSetDigest` 也不同。
 */
import { stringMatcher } from '../config/matchers.js';
import { structuredCallee } from '../facts/structured.js';
import { operatorCategory } from './core.js';

export const CONFIG_RULES_ENGINE_VERSION = '1.0.0';

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
    blocker: rule.blocker ?? 'PROTECTED_ARGUMENT_CHANGED',
  }));

  const handled = (blockers) => (blockers.length > 0 ? { handled: true, blockers: [...new Set(blockers)] } : { handled: false });

  return Object.freeze({
    id: 'config-rules',
    version: `${CONFIG_RULES_ENGINE_VERSION}+${digest.slice(0, 16)}`,
    interpret(fact) {
      const properties = fact?.properties ?? {};

      if (fact?.kind === 'BINARY_OPERATOR_CHANGED') {
        const operators = [operatorCategory(properties.operatorBefore), operatorCategory(properties.operatorAfter)];
        const expressions = [properties.before, properties.after].filter((value) => typeof value === 'string');
        const hit = sensitive.some((rule) => (rule.operators === 'any' || operators.includes(rule.operators))
          && expressions.some((expression) => rule.matches(expression)));
        return handled(hit ? ['SENSITIVE_OPERAND_CHANGED'] : []);
      }

      const callee = structuredCallee(properties.callee);
      if (!callee) return { handled: false };

      if (fact.kind === 'CALL_REMOVED') {
        return handled(protectedCalls.some((matches) => matches(callee)) ? ['PROTECTED_CALL_REMOVED'] : []);
      }
      if (fact.kind === 'CALL_ADDED') {
        return handled(sideEffects.some((matches) => matches(callee)) ? ['SIDE_EFFECT_CALL_ADDED'] : []);
      }
      if (['CALL_ARGUMENT_CHANGED', 'CALL_ARGUMENT_REMOVED', 'CALL_ARGUMENT_ADDED'].includes(fact.kind)) {
        return handled(protectedArguments
          .filter((rule) => rule.callee(callee) && rule.argument(properties.argument))
          .map((rule) => rule.blocker));
      }
      return { handled: false };
    },
  });
}
