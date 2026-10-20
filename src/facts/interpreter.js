import { createHash } from 'node:crypto';

import { stableStrings } from '../contracts.js';

/**
 * canonicalize interpreter identity set。
 *
 * @param {object[]} [interpreters=[]] - interpreter descriptors 或 identity set。
 * @returns {{id: string, version: string}[]} sorted identity set。
 */
export function canonicalInterpreterSet(interpreters = []) {
  return interpreters
    .map(({ id, version }) => ({ id, version }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1
        : left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
}

/**
 * 驗證 context binding 中的 interpreter identity set。
 *
 * @param {unknown} interpreterSet - identity descriptors。
 * @returns {{valid: boolean, errors: string[]}} validation result。
 */
export function validateInterpreterIdentitySet(interpreterSet) {
  if (!Array.isArray(interpreterSet)) {
    return { valid: false, errors: ['INTERPRETER_SET_INVALID'] };
  }

  const errors = [];
  const ids = interpreterSet.map((item) => item?.id);
  if (new Set(ids).size !== ids.length) errors.push('INTERPRETER_SET_DUPLICATE_ID');

  for (const item of interpreterSet) {
    const id = typeof item?.id === 'string' && item.id.trim() !== '' ? item.id : 'unknown';
    if (id === 'unknown') errors.push('INTERPRETER_ID_MISSING');
    if (typeof item?.version !== 'string' || item.version.trim() === '') {
      errors.push(`INTERPRETER_VERSION_MISSING:${id}`);
    }
    if (
      item
      && typeof item === 'object'
      && Object.keys(item).some((key) => !['id', 'version'].includes(key))
    ) {
      errors.push(`INTERPRETER_IDENTITY_INVALID:${id}`);
    }
  }

  const stableErrors = stableStrings(errors);
  return { valid: stableErrors.length === 0, errors: stableErrors };
}

/**
 * 驗證 executable fact interpreter descriptors。
 *
 * @param {unknown} interpreters - interpreter descriptors。
 * @returns {{valid: boolean, errors: string[]}} validation result。
 */
export function validateFactInterpreters(interpreters) {
  if (!Array.isArray(interpreters)) {
    return { valid: false, errors: ['INTERPRETER_SET_INVALID'] };
  }

  const identityValidation = validateInterpreterIdentitySet(
    interpreters.map((item) => ({ id: item?.id, version: item?.version })),
  );
  const errors = [...identityValidation.errors];

  for (const item of interpreters) {
    const id = typeof item?.id === 'string' && item.id.trim() !== '' ? item.id : 'unknown';
    if (!item || typeof item !== 'object' || typeof item.interpret !== 'function') {
      errors.push(`INTERPRETER_EXECUTABLE_MISSING:${id}`);
    }
  }

  const stableErrors = stableStrings(errors);
  return { valid: stableErrors.length === 0, errors: stableErrors };
}

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
 * Interpreter 必須提供 id/version/interpret；id/version 會進 AnalysisContextBinding。
 * 任一 fact 若沒有受信任 interpreter 處理，必須 fail-closed 成為 blocker。
 *
 * @param {object[]} [facts=[]] - normalized semantic facts。
 * @param {object[]} [interpreters=[]] - 受信任 interpreter descriptors。
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

  const interpreterValidation = validateFactInterpreters(interpreters);
  if (!interpreterValidation.valid) {
    return {
      handledFactIds: [],
      unhandledFactIds: facts
        .map((fact) => fact?.id)
        .filter((id) => typeof id === 'string')
        .sort(),
      blockers: ['ANALYZER_FACT_INTERPRETER_SET_INVALID'],
    };
  }

  for (const fact of facts) {
    let handled = false;

    for (const interpreter of interpreters) {
      let result;
      try {
        result = interpreter.interpret(fact, context);
      } catch {
        handled = true;
        blockers.push(`ANALYZER_FACT_INTERPRETER_FAILED:${interpreter.id}:${fact.id}`);
        continue;
      }

      if (result === undefined || result === null || result.handled === false) {
        continue;
      }

      handled = true;
      if (!isHandledResult(result)) {
        blockers.push(
          `ANALYZER_FACT_INTERPRETER_INVALID_RESULT:${interpreter.id}:${fact.id}`,
        );
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

/**
 * 每個 blocker 由哪些 interpreter 產生（`id@version`），供人工豁免綁定「產生這個 blocker 的規則」。
 * 沒有 interpreter 處理（`FACT_UNHANDLED`）或 interpreter set 無效時，來源是整組 interpreter
 * （新增或修改任何一個 interpreter 都可能改變結果），以 `set:<整組 identity 的 sha256 前 16 碼>` 表示，
 * 避免沒有規則的 fact 很多時報表變大。
 *
 * @param {object} fact - normalized semantic fact。
 * @param {object[]} [interpreters=[]] - 受信任 interpreter descriptors。
 * @returns {Object<string, string[]>} blocker → 排序後的 interpreter identity。
 */
export function blockerSources(fact, interpreters = []) {
  const identity = (interpreter) => `${interpreter?.id}@${interpreter?.version}`;
  const sources = new Map();
  const add = (blocker, identities) => sources.set(blocker, stableStrings([...(sources.get(blocker) ?? []), ...identities]));
  const combined = interpretSemanticFacts([fact], interpreters);
  if (!validateFactInterpreters(interpreters).valid || combined.unhandledFactIds.length > 0) {
    const all = stableStrings(Array.isArray(interpreters) ? interpreters.map(identity) : []);
    const set = `set:${createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 16)}`;
    for (const blocker of combined.blockers) add(blocker, [set]);
    return Object.fromEntries(sources);
  }
  for (const interpreter of interpreters) {
    for (const blocker of interpretSemanticFacts([fact], [interpreter]).blockers) {
      if (!blocker.startsWith('FACT_UNHANDLED')) add(blocker, [identity(interpreter)]);
    }
  }
  return Object.fromEntries(sources);
}
