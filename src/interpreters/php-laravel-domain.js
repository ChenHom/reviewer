/**
 * PHP/Laravel 第一批 deterministic domain interpreters。
 *
 * Adapter 僅輸出 provider-neutral facts；這一層才把 fact 映射成
 * review blockers。每個 interpreter 都有穩定 id/version，會被綁入
 * AnalysisContextBinding。callee 與 container 使用 fact schema v2 的結構化欄位
 * （見 `src/facts/structured.js`）。
 */
import { receiverIs, receiverLast, structuredCallee, structuredContainer } from '../facts/structured.js';

/**
 * 判斷 receiver 是否為資料庫連線（DB facade、`$db`、`$this->adminDB` 等）。
 *
 * @param {object} callee - structured callee。
 * @returns {boolean} 是否為 DB-like receiver。
 */
function isDatabaseReceiver(callee) {
  return /^(DB|\w*db|\w*DB|\w*connection|pdo)$/i.test(receiverLast(callee));
}

/**
 * 從 PHP expression 取出所有字串 literal。
 *
 * @param {string} expression - PHP source fragment。
 * @returns {string[]} 字串內容。
 */
function stringLiterals(expression) {
  return [...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1] ?? match[2]);
}

/**
 * 取出 `'middleware' => ...` 宣告的 middleware 名稱。
 *
 * @param {string} expression - Route::group 第一個參數。
 * @returns {string[]} middleware 名稱。
 */
function groupMiddlewares(expression) {
  const match = /['"]middleware['"]\s*=>\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(expression);
  return match ? stringLiterals(match[1]) : [];
}

export const PAYMENT_IDEMPOTENCY_INTERPRETER = Object.freeze({
  id: 'php-laravel-payment-idempotency',
  version: '1.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_ARGUMENT_CHANGED'
      || fact?.properties?.argument !== 'idempotencyKey'
    ) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED'],
    };
  },
});

const transactionBoundaryMethods = new Set(['transaction', 'beginTransaction', 'commit']);
const rollbackMethods = new Set(['rollBack', 'rollback']);

export const TRANSACTION_BOUNDARY_INTERPRETER = Object.freeze({
  id: 'php-laravel-transaction-boundary',
  version: '2.0.0',
  interpret(fact) {
    const callee = structuredCallee(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_REMOVED' || !callee) return { handled: false };

    const onDatabase = isDatabaseReceiver(callee);
    if (
      callee.name === 'beginTransaction'
      || (onDatabase && transactionBoundaryMethods.has(callee.name))
    ) {
      return { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED'] };
    }
    if (onDatabase && rollbackMethods.has(callee.name)) {
      return { handled: true, blockers: ['TRANSACTION_ROLLBACK_REMOVED'] };
    }

    return { handled: false };
  },
});

const gateReceivers = ['Gate', 'Illuminate\\Support\\Facades\\Gate'];

/**
 * `$this->authorize` / `$this->authorizeForUser` / `Gate::authorize`（含 FQN）。
 *
 * @param {unknown} value - callee。
 * @returns {boolean} 是否為 authorization call。
 */
function isAuthorizationCallee(value) {
  const callee = structuredCallee(value);
  if (!callee) return false;
  if (callee.kind === 'method') {
    return !callee.optional
      && receiverIs(callee, ['this'])
      && ['authorize', 'authorizeForUser'].includes(callee.name);
  }
  return callee.kind === 'static' && receiverIs(callee, gateReceivers) && callee.name === 'authorize';
}

export const AUTHORIZATION_GUARD_INTERPRETER = Object.freeze({
  id: 'php-laravel-authorization-guard',
  version: '2.0.0',
  interpret(fact) {
    // `$this->authorize('update', $post)` 的 ability 字串被改成另一個值。
    if (fact?.kind === 'LITERAL_CHANGED') {
      const container = structuredContainer(fact?.properties?.container);
      return container?.type === 'argument'
        && container.argument === 0
        && container.keys.length === 0
        && isAuthorizationCallee(container.callee)
        ? { handled: true, blockers: ['AUTHORIZATION_ABILITY_CHANGED'] }
        : { handled: false };
    }

    if (fact?.kind !== 'CALL_REMOVED' || !isAuthorizationCallee(fact?.properties?.callee)) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['AUTHORIZATION_GUARD_REMOVED'],
    };
  },
});

const middlewareProperties = new Set(['middleware', 'middlewares', 'beforeActionList']);

/**
 * 判斷 container 是否為 middleware 宣告：`$middleware` / `$beforeActionList` property、
 * `[... 'middleware' => ...]` 的值，或 `->middleware(...)` / `Route::middleware(...)` 的位置參數。
 *
 * @param {unknown} value - fact properties.container。
 * @returns {boolean} 是否為 middleware container。
 */
function isMiddlewareContainer(value) {
  const container = structuredContainer(value);
  if (!container) return false;
  if (container.type === 'property') {
    return container.keys.length === 0 && middlewareProperties.has(container.name);
  }

  const callee = structuredCallee(container.callee);
  return container.keys.at(-1) === 'middleware'
    || (
      container.type === 'argument'
      && typeof container.argument === 'number'
      && container.keys.length === 0
      && callee?.name === 'middleware'
      && ['method', 'static'].includes(callee.kind)
    );
}

/**
 * `Route::group`（含 `\Route::group`）。
 *
 * @param {object|null} callee - structured callee。
 * @returns {boolean} 是否為 Route::group。
 */
function isRouteGroup(callee) {
  return callee?.kind === 'static' && receiverIs(callee, ['Route']) && callee.name === 'group';
}

/**
 * before 中有、after 中沒有的字串 literal。
 *
 * @param {unknown} before - 變更前的 PHP 片段。
 * @param {unknown} after - 變更後的 PHP 片段。
 * @returns {string[]} 被移除的字串。
 */
function removedStrings(before, after) {
  const remaining = new Set(stringLiterals(String(after ?? '')));
  return stringLiterals(String(before ?? '')).filter((name) => !remaining.has(name));
}

export const MIDDLEWARE_GUARD_INTERPRETER = Object.freeze({
  id: 'php-laravel-middleware-guard',
  version: '2.0.0',
  interpret(fact) {
    // middleware 名稱被改成另一個字串（`'auth'` → `'guest'`）：原本的 middleware 不再套用。
    if (fact?.kind === 'LITERAL_CHANGED' && isMiddlewareContainer(fact?.properties?.container)) {
      return removedStrings(fact.properties.before, fact.properties.after).length > 0
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }

    // `Route::group(['middleware' => [...]])`、`->middleware([...])` 或
    // `$middleware` / `$beforeActionList` property 中移除一個元素，
    // 或整個 `'middleware' => ...` 設定被移除。
    if (
      fact?.kind === 'ARRAY_ITEM_REMOVED'
      && (
        isMiddlewareContainer(fact?.properties?.container)
        || /^['"]middleware['"]$/.test(fact?.properties?.key ?? '')
      )
    ) {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }

    const callee = structuredCallee(fact?.properties?.callee);
    if (!callee) return { handled: false };

    // `$this->middleware('auth')` / `Route::middleware(...)` 整個 call 被移除。
    if (fact.kind === 'CALL_REMOVED' && callee.name === 'middleware') {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }

    // `->middleware('auth', 'verified')` 移除一個參數，或 `Route::group([...'middleware'...], fn)` 移除設定參數。
    if (fact.kind === 'CALL_ARGUMENT_REMOVED') {
      const value = String(fact.properties.value ?? '');
      return callee.name === 'middleware' || (isRouteGroup(callee) && groupMiddlewares(value).length > 0)
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }

    if (fact.kind !== 'CALL_ARGUMENT_CHANGED') return { handled: false };

    const before = String(fact.properties.before ?? '');
    const after = String(fact.properties.after ?? '');
    let removed;
    if (callee.name === 'middleware') {
      removed = removedStrings(before, after);
    } else if (isRouteGroup(callee) && fact.properties.argument === 0) {
      const remaining = new Set(groupMiddlewares(after));
      removed = groupMiddlewares(before).filter((name) => !remaining.has(name));
    } else {
      return { handled: false };
    }

    // 只有 middleware 被移除才是 guard blocker；新增或其他變更交給 generic fallback。
    return removed.length > 0
      ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
      : { handled: false };
  },
});

const rowLockMethods = new Set(['lockForUpdate', 'sharedLock']);

export const ROW_LOCK_INTERPRETER = Object.freeze({
  id: 'php-laravel-row-lock',
  version: '2.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_REMOVED'
      || !rowLockMethods.has(structuredCallee(fact?.properties?.callee)?.name)
    ) {
      return { handled: false };
    }

    return { handled: true, blockers: ['ROW_LOCK_REMOVED'] };
  },
});

const signatureVerificationMethod = /(verif\w*sign|check\w*sign|validate\w*sign|sign\w*(verif|check|valid))/i;

export const SIGNATURE_VERIFICATION_INTERPRETER = Object.freeze({
  id: 'php-laravel-signature-verification',
  version: '2.0.0',
  interpret(fact) {
    const method = structuredCallee(fact?.properties?.callee)?.name;
    if (
      fact?.kind !== 'CALL_REMOVED'
      || typeof method !== 'string'
      || !signatureVerificationMethod.test(method)
    ) {
      return { handled: false };
    }

    return { handled: true, blockers: ['SIGNATURE_VERIFICATION_REMOVED'] };
  },
});

const comparisonOperators = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '<>', '<=>']);
const arithmeticOperators = new Set(['+', '-', '*', '/', '%', '**']);
const logicalOperators = new Set(['&&', '||', 'and', 'or', 'xor']);

/**
 * 依 operator 類別回傳 blocker。
 *
 * @param {string} before - 變更前 operator。
 * @param {string} after - 變更後 operator。
 * @returns {string} blocker code。
 */
function operatorBlocker(before, after) {
  const both = (set) => set.has(before) && set.has(after);
  if (both(comparisonOperators)) return 'COMPARISON_OPERATOR_CHANGED';
  if (both(arithmeticOperators)) return 'ARITHMETIC_OPERATOR_CHANGED';
  if (both(logicalOperators)) return 'LOGICAL_OPERATOR_CHANGED';
  return 'OPERATOR_CHANGED';
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

const valueFactKinds = new Set(['LITERAL_CHANGED', 'ARRAY_ITEM_REMOVED', 'ARRAY_ITEM_ADDED', 'RETURN_VALUE_CHANGED']);

/**
 * fact 是否位於 method `name` 的回傳值中（例如 FormRequest 的 `rules()`、Model 的 `casts()`）。
 *
 * @param {object} fact - semantic fact。
 * @param {string} name - method 名稱。
 * @returns {boolean} 是否在該 method 的 return 中。
 */
function inReturnOf(fact, name) {
  return typeof fact?.subject === 'string'
    && fact.subject.endsWith(`::${name}`)
    && (fact.kind === 'RETURN_VALUE_CHANGED' || structuredContainer(fact?.properties?.container)?.type === 'return');
}

const validatorReceivers = ['Validator', 'Illuminate\\Support\\Facades\\Validator'];

/**
 * 位置參數 container 是否屬於 `$this->validate(...)` / `$request->validateWithBag(...)` 或
 * `Validator::make($data, [...])` 的規則參數。
 *
 * @param {object|null} container - structured container。
 * @returns {boolean} 是否為 validation rules 參數。
 */
function isValidationArgument(container) {
  const callee = structuredCallee(container?.callee);
  if (container?.type !== 'argument' || typeof container.argument !== 'number' || !callee) return false;

  if (callee.kind === 'method') {
    return !callee.optional
      && callee.receiver?.length === 1
      && /^(this|\w*request\w*)$/i.test(callee.receiver[0])
      && /^validate(WithBag)?$/i.test(callee.name);
  }
  return callee.kind === 'static'
    && receiverIs(callee, validatorReceivers)
    && callee.name === 'make'
    && container.argument === 1;
}

export const LARAVEL_VALIDATION_INTERPRETER = Object.freeze({
  id: 'laravel-validation-rules',
  version: '2.0.0',
  interpret(fact) {
    if (!valueFactKinds.has(fact?.kind)) return { handled: false };

    // FormRequest::rules() 的回傳值、`$request->validate([...])`、`Validator::make($data, [...])`。
    // `Auth::guard()->validate([...])` 是驗證帳密而不是規則，因此只認 `$this` 與 request 變數。
    if (inReturnOf(fact, 'rules') || isValidationArgument(structuredContainer(fact?.properties?.container))) {
      return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };
    }

    return { handled: false };
  },
});

const modelAttributeProperties = Object.freeze({
  fillable: 'MASS_ASSIGNMENT_CHANGED',
  guarded: 'MASS_ASSIGNMENT_CHANGED',
  hidden: 'SERIALIZED_ATTRIBUTES_CHANGED',
  visible: 'SERIALIZED_ATTRIBUTES_CHANGED',
  casts: 'ATTRIBUTE_CAST_CHANGED',
});

/**
 * `$fillable` / `$guarded` / `$hidden` / `$visible` / `$casts` property 本身（不含巢狀 key）對應的 blocker。
 *
 * @param {unknown} value - fact properties.container。
 * @returns {string|null} blocker。
 */
function modelPropertyBlocker(value) {
  const container = structuredContainer(value);
  return container?.type === 'property'
    && container.keys.length === 0
    && Object.hasOwn(modelAttributeProperties, container.name)
    ? modelAttributeProperties[container.name]
    : null;
}

export const LARAVEL_MODEL_ATTRIBUTES_INTERPRETER = Object.freeze({
  id: 'laravel-model-attributes',
  version: '2.0.0',
  interpret(fact) {
    if (!valueFactKinds.has(fact?.kind)) return { handled: false };

    const blocker = modelPropertyBlocker(fact?.properties?.container)
      ?? (inReturnOf(fact, 'casts') ? 'ATTRIBUTE_CAST_CHANGED' : null);

    return blocker ? { handled: true, blockers: [blocker] } : { handled: false };
  },
});

export const PHP_LARAVEL_DOMAIN_INTERPRETERS = Object.freeze([
  PAYMENT_IDEMPOTENCY_INTERPRETER,
  TRANSACTION_BOUNDARY_INTERPRETER,
  AUTHORIZATION_GUARD_INTERPRETER,
  MIDDLEWARE_GUARD_INTERPRETER,
  ROW_LOCK_INTERPRETER,
  SIGNATURE_VERIFICATION_INTERPRETER,
  OPERATOR_CHANGE_INTERPRETER,
  GUARD_CLAUSE_INTERPRETER,
  NEGATION_INTERPRETER,
  RETURN_VALUE_INTERPRETER,
  ARGUMENT_ORDER_INTERPRETER,
  VARIABLE_CHANGE_INTERPRETER,
  CONSTANT_VALUE_INTERPRETER,
  LARAVEL_VALIDATION_INTERPRETER,
  LARAVEL_MODEL_ATTRIBUTES_INTERPRETER,
]);
