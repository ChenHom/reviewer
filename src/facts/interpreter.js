import { stableStrings } from '../contracts.js';

/**
 * 驗證單一 interpreter result。
 *
 * @param {unknown} result - interpreter 回傳值。
 * @returns {boolean} 是否為合法 handled result。
 */
function isHandledResult(result) {
  return Boolean(
    result
    && typeof result === 'object'
    && result.handled === true
    && (
      result.blockers === undefined
      || (
        Array.isArray(result.blockers)
        && result.blockers.every(
          (blocker) => typeof blocker === 'string' && blocker.trim() !== '',
        )
      )
    ),
  );
}

/**
 * 執行 provider-neutral semantic fact interpretation。
 *
 * Interpreter 是 policy/analyzer boundary，不是 Adapter 的一部分。
 * 任一 fact 若沒有受信任 interpreter 處理，必須 fail-closed 成為 blocker。
 *
 * @param {object[]} [facts=[]] - normalized semantic facts。
 * @param {function[]} [interpreters=[]] - 受信任 interpreter functions。
 * @param {object} [context={}] - identity/context binding。
 * @returns {{
 *   handledFactIds: string[],
 *   unhandledFactIds: string[],
 *   blockers: string[]
 * }} deterministic fact assessment。
 */
export function interpretSemanticFacts(facts = [], interpreters = [], context = {}) {
  const handledFactIds = [];
  const unhandledFactIds = [];
  const blockers = [];

  if (!Array.isArray(facts)) {
    return {
      handledFactIds: [],
      unhandledFactIds: [],
      blockers: ['ANALYZER_SEMANTIC_FACTS_INVALID'],
    };
  }

  if (!Array.isArray(interpreters) || interpreters.some((item) => typeof item !== 'function')) {
    return {
      handledFactIds: [],
      unhandledFactIds: facts
        .map((fact) => fact?.id)
        .filter((id) => typeof id === 'string')
        .sort(),
      blockers: ['ANALYZER_FACT_INTERPRETER_INVALID'],
    };
  }

  for (const fact of facts) {
    let handled = false;

    for (const interpreter of interpreters) {
      let result;
      try {
        result = interpreter(fact, context);
      } catch {
        handled = true;
        blockers.push(`ANALYZER_FACT_INTERPRETER_FAILED:${fact.id}`);
        continue;
      }

      if (result === undefined || result === null || result.handled === false) {
        continue;
      }

      handled = true;
      if (!isHandledResult(result)) {
        blockers.push(`ANALYZER_FACT_INTERPRETER_INVALID_RESULT:${fact.id}`);
        continue;
      }

      blockers.push(...(result.blockers ?? []));
    }

    if (handled) {
      handledFactIds.push(fact.id);
    } else {
      unhandledFactIds.push(fact.id);
      blockers.push(`FACT_UNHANDLED:${fact.id}`);
    }
  }

  return {
    handledFactIds: stableStrings(handledFactIds),
    unhandledFactIds: stableStrings(unhandledFactIds),
    blockers: stableStrings(blockers),
  };
}
