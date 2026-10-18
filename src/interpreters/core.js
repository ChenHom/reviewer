/**
 * 語言層 interpreters：與框架、業務無關的變更（運算子、guard clause、條件反轉、回傳值、
 * 參數順序、變數、常數、decorator / attribute、指示註解）。所有語言共用；
 * 原有的 id 沿用 `php-` 前綴以維持 interpreter identity，之後新增的用 `core-`。
 *
 * 運算子集合目前以 PHP 為準（含 `<>`、`and` / `or` / `xor`）；其他語言的運算子不在集合中時
 * 回傳 `OPERATOR_CHANGED`，仍是 blocker。
 */
import { structuredContainer } from '../facts/structured.js';

const operatorCategories = Object.freeze({
  comparison: new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '<>', '<=>']),
  arithmetic: new Set(['+', '-', '*', '/', '%', '**']),
  logical: new Set(['&&', '||', 'and', 'or', 'xor']),
});

/**
 * 運算子類別：`comparison`、`arithmetic`、`logical`；不在集合中時為 null。
 *
 * @param {string} operator - 運算子。
 * @returns {string|null} 類別。
 */
export function operatorCategory(operator) {
  return Object.keys(operatorCategories).find((category) => operatorCategories[category].has(operator)) ?? null;
}

const categoryBlockers = Object.freeze({
  comparison: 'COMPARISON_OPERATOR_CHANGED',
  arithmetic: 'ARITHMETIC_OPERATOR_CHANGED',
  logical: 'LOGICAL_OPERATOR_CHANGED',
});

/**
 * 依 operator 類別回傳 blocker：前後屬於同一類別時用該類別的代碼，否則 `OPERATOR_CHANGED`。
 *
 * @param {string} before - 變更前 operator。
 * @param {string} after - 變更後 operator。
 * @returns {string} blocker code。
 */
function operatorBlocker(before, after) {
  const category = operatorCategory(before);
  return category !== null && category === operatorCategory(after) ? categoryBlockers[category] : 'OPERATOR_CHANGED';
}

export const OPERATOR_CHANGE_INTERPRETER = Object.freeze({
  id: 'php-operator-change',
  version: '1.0.0',
  interpret(fact) {
    const before = fact?.properties?.operatorBefore;
    const after = fact?.properties?.operatorAfter;
    if (
      fact?.kind !== 'BINARY_OPERATOR_CHANGED'
      || typeof before !== 'string'
      || typeof after !== 'string'
    ) {
      return { handled: false };
    }

    return { handled: true, blockers: [operatorBlocker(before, after)] };
  },
});

export const GUARD_CLAUSE_INTERPRETER = Object.freeze({
  id: 'php-guard-clause',
  version: '1.0.0',
  interpret(fact) {
    if (fact?.kind === 'GUARD_REMOVED') {
      return { handled: true, blockers: ['GUARD_CLAUSE_REMOVED'] };
    }
    if (fact?.kind === 'GUARD_ADDED') {
      return { handled: true, blockers: ['GUARD_CLAUSE_ADDED'] };
    }

    return { handled: false };
  },
});

const conditionContainers = new Set(['if', 'while', 'for', 'ternary', 'match', 'match-arm']);

export const NEGATION_INTERPRETER = Object.freeze({
  id: 'php-negation',
  version: '2.0.0',
  interpret(fact) {
    if (fact?.kind !== 'EXPRESSION_NEGATED') return { handled: false };

    const container = structuredContainer(fact?.properties?.container);
    const condition = conditionContainers.has(container?.type) && container.keys.length === 0;
    return {
      handled: true,
      blockers: [condition ? 'CONDITION_NEGATED' : 'BOOLEAN_VALUE_NEGATED'],
    };
  },
});

export const RETURN_VALUE_INTERPRETER = Object.freeze({
  id: 'php-return-value',
  version: '1.0.0',
  interpret(fact) {
    return fact?.kind === 'RETURN_VALUE_CHANGED'
      ? { handled: true, blockers: ['RETURN_VALUE_CHANGED'] }
      : { handled: false };
  },
});

export const ARGUMENT_ORDER_INTERPRETER = Object.freeze({
  id: 'php-argument-order',
  version: '1.0.0',
  interpret(fact) {
    return fact?.kind === 'CALL_ARGUMENTS_REORDERED'
      ? { handled: true, blockers: ['ARGUMENTS_REORDERED'] }
      : { handled: false };
  },
});

export const VARIABLE_CHANGE_INTERPRETER = Object.freeze({
  id: 'php-variable-change',
  version: '2.0.0',
  interpret(fact) {
    if (fact?.kind !== 'VARIABLE_CHANGED') return { handled: false };

    // 參數改名會改變 named argument 的 API；其他位置是改用另一個變數（資料流改變）。
    const container = structuredContainer(fact?.properties?.container);
    const parameter = container?.type === 'param' && container.keys.length === 0;
    return {
      handled: true,
      blockers: [parameter ? 'PARAMETER_RENAMED' : 'VARIABLE_REFERENCE_CHANGED'],
    };
  },
});

export const CONSTANT_VALUE_INTERPRETER = Object.freeze({
  id: 'php-constant-value',
  version: '2.0.0',
  interpret(fact) {
    return fact?.kind === 'LITERAL_CHANGED' && structuredContainer(fact?.properties?.container)?.type === 'const'
      ? { handled: true, blockers: ['CONSTANT_VALUE_CHANGED'] }
      : { handled: false };
  },
});

export const ANNOTATION_INTERPRETER = Object.freeze({
  id: 'core-annotation',
  version: '1.0.0',
  interpret(fact) {
    if (fact?.kind === 'ANNOTATION_REMOVED') return { handled: true, blockers: ['ANNOTATION_REMOVED'] };
    if (fact?.kind === 'ANNOTATION_ADDED') return { handled: true, blockers: ['ANNOTATION_ADDED'] };
    return { handled: false };
  },
});

export const DIRECTIVE_COMMENT_INTERPRETER = Object.freeze({
  id: 'core-directive-comment',
  version: '1.0.0',
  interpret(fact) {
    return fact?.kind === 'DIRECTIVE_COMMENT_CHANGED'
      ? { handled: true, blockers: ['DIRECTIVE_COMMENT_CHANGED'] }
      : { handled: false };
  },
});

export const CORE_INTERPRETERS = Object.freeze([
  OPERATOR_CHANGE_INTERPRETER,
  GUARD_CLAUSE_INTERPRETER,
  NEGATION_INTERPRETER,
  RETURN_VALUE_INTERPRETER,
  ARGUMENT_ORDER_INTERPRETER,
  VARIABLE_CHANGE_INTERPRETER,
  CONSTANT_VALUE_INTERPRETER,
  ANNOTATION_INTERPRETER,
  DIRECTIVE_COMMENT_INTERPRETER,
]);
