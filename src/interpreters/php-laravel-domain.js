/**
 * PHP/Laravel 第一批 deterministic domain interpreters。
 *
 * Adapter 僅輸出 provider-neutral facts；這一層才把 fact 映射成
 * review blockers。每個 interpreter 都有穩定 id/version，會被綁入
 * AnalysisContextBinding。
 */

/**
 * 拆解 callee 為 receiver 與 method，並移除 fully-qualified 前導 `\`。
 *
 * 例：`\DB::transaction` → `{ receiver: 'DB', method: 'transaction', normalized: 'DB::transaction' }`；
 * `->lockForUpdate`（鏈式 call）→ `{ receiver: '', method: 'lockForUpdate', ... }`。
 *
 * @param {unknown} callee - fact properties.callee。
 * @returns {{receiver: string, method: string, normalized: string}|null} callee parts；非字串回傳 null。
 */
export function calleeParts(callee) {
  if (typeof callee !== 'string' || callee === '') return null;

  const normalized = callee.replace(/^\\/, '');
  const match = /^(.*?)(->|\?->|::)([A-Za-z_][A-Za-z0-9_]*)$/.exec(normalized);
  if (!match) return { receiver: '', method: normalized, normalized };

  return {
    receiver: match[1].replace(/^\\/, ''),
    method: match[3],
    normalized,
  };
}

/**
 * 判斷 receiver 是否為資料庫連線（DB facade、`$db`、`$this->adminDB` 等）。
 *
 * @param {string} receiver - callee receiver。
 * @returns {boolean} 是否為 DB-like receiver。
 */
function isDatabaseReceiver(receiver) {
  const last = receiver.split(/->|::|\\/).pop() ?? '';
  return /^(DB|\$?\w*db|\$?\w*DB|\$?\w*connection|\$?pdo)$/i.test(last);
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
  version: '1.1.0',
  interpret(fact) {
    const parts = calleeParts(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_REMOVED' || !parts) return { handled: false };

    const onDatabase = isDatabaseReceiver(parts.receiver);
    if (
      parts.method === 'beginTransaction'
      || (onDatabase && transactionBoundaryMethods.has(parts.method))
    ) {
      return { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED'] };
    }
    if (onDatabase && rollbackMethods.has(parts.method)) {
      return { handled: true, blockers: ['TRANSACTION_ROLLBACK_REMOVED'] };
    }

    return { handled: false };
  },
});

const authorizationCallees = new Set([
  '$this->authorize',
  '$this->authorizeForUser',
  'Gate::authorize',
  'Illuminate\\Support\\Facades\\Gate::authorize',
]);

export const AUTHORIZATION_GUARD_INTERPRETER = Object.freeze({
  id: 'php-laravel-authorization-guard',
  version: '1.2.0',
  interpret(fact) {
    // `$this->authorize('update', $post)` 的 ability 字串被改成另一個值。
    const container = fact?.properties?.container;
    if (fact?.kind === 'LITERAL_CHANGED' && typeof container === 'string') {
      const match = /^(.*)#0$/.exec(container);
      return match && authorizationCallees.has(calleeParts(match[1])?.normalized)
        ? { handled: true, blockers: ['AUTHORIZATION_ABILITY_CHANGED'] }
        : { handled: false };
    }

    if (
      fact?.kind !== 'CALL_REMOVED'
      || !authorizationCallees.has(calleeParts(fact?.properties?.callee)?.normalized)
    ) {
      return { handled: false };
    }

    return {
      handled: true,
      blockers: ['AUTHORIZATION_GUARD_REMOVED'],
    };
  },
});

const middlewareProperties = new Set(['$middleware', '$middlewares', '$beforeActionList']);

/**
 * 判斷 ARRAY_ITEM_REMOVED 的 container 是否為 middleware 宣告。
 *
 * @param {unknown} container - fact properties.container。
 * @returns {boolean} 是否為 middleware container。
 */
function isMiddlewareContainer(container) {
  if (typeof container !== 'string') return false;
  if (container.startsWith('property:')) {
    return middlewareProperties.has(container.slice('property:'.length));
  }

  return /\[middleware\]$/.test(container) || /(->|::)middleware#\d+$/.test(container);
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
  version: '1.2.0',
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

    const parts = calleeParts(fact?.properties?.callee);
    if (!parts) return { handled: false };

    // `$this->middleware('auth')` / `Route::middleware(...)` 整個 call 被移除。
    if (fact.kind === 'CALL_REMOVED' && parts.method === 'middleware') {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }

    if (fact.kind !== 'CALL_ARGUMENT_CHANGED') return { handled: false };

    const before = String(fact.properties.before ?? '');
    const after = String(fact.properties.after ?? '');
    let removed;
    if (parts.method === 'middleware') {
      removed = removedStrings(before, after);
    } else if (parts.normalized === 'Route::group' && fact.properties.argument === '#0') {
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
  version: '1.0.0',
  interpret(fact) {
    if (
      fact?.kind !== 'CALL_REMOVED'
      || !rowLockMethods.has(calleeParts(fact?.properties?.callee)?.method)
    ) {
      return { handled: false };
    }

    return { handled: true, blockers: ['ROW_LOCK_REMOVED'] };
  },
});

const signatureVerificationMethod = /(verif\w*sign|check\w*sign|validate\w*sign|sign\w*(verif|check|valid))/i;

export const SIGNATURE_VERIFICATION_INTERPRETER = Object.freeze({
  id: 'php-laravel-signature-verification',
  version: '1.0.0',
  interpret(fact) {
    const method = calleeParts(fact?.properties?.callee)?.method;
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
  version: '1.0.0',
  interpret(fact) {
    if (fact?.kind !== 'EXPRESSION_NEGATED') return { handled: false };

    return {
      handled: true,
      blockers: [conditionContainers.has(fact?.properties?.container) ? 'CONDITION_NEGATED' : 'BOOLEAN_VALUE_NEGATED'],
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
  version: '1.0.0',
  interpret(fact) {
    if (fact?.kind !== 'VARIABLE_CHANGED') return { handled: false };

    // 參數改名會改變 named argument 的 API；其他位置是改用另一個變數（資料流改變）。
    return {
      handled: true,
      blockers: [fact?.properties?.container === 'param' ? 'PARAMETER_RENAMED' : 'VARIABLE_REFERENCE_CHANGED'],
    };
  },
});

export const CONSTANT_VALUE_INTERPRETER = Object.freeze({
  id: 'php-constant-value',
  version: '1.0.0',
  interpret(fact) {
    const container = fact?.properties?.container;
    return fact?.kind === 'LITERAL_CHANGED' && typeof container === 'string' && container.startsWith('const:')
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
  const container = fact?.properties?.container;
  return typeof fact?.subject === 'string'
    && fact.subject.endsWith(`::${name}`)
    && (fact.kind === 'RETURN_VALUE_CHANGED' || (typeof container === 'string' && container.startsWith('return')));
}

export const LARAVEL_VALIDATION_INTERPRETER = Object.freeze({
  id: 'laravel-validation-rules',
  version: '1.0.0',
  interpret(fact) {
    if (!valueFactKinds.has(fact?.kind)) return { handled: false };

    // FormRequest::rules() 的回傳值、`$request->validate([...])`、`Validator::make($data, [...])`。
    // `Auth::guard()->validate([...])` 是驗證帳密而不是規則，因此只認 `$this` 與 request 變數。
    const container = String(fact?.properties?.container ?? '');
    if (
      inReturnOf(fact, 'rules')
      || /^\$(this|\w*request\w*)->validate(WithBag)?#\d+/i.test(container)
      || /^\\?(Illuminate\\Support\\Facades\\)?Validator::make#1/.test(container)
    ) {
      return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };
    }

    return { handled: false };
  },
});

const modelAttributeProperties = Object.freeze({
  'property:$fillable': 'MASS_ASSIGNMENT_CHANGED',
  'property:$guarded': 'MASS_ASSIGNMENT_CHANGED',
  'property:$hidden': 'SERIALIZED_ATTRIBUTES_CHANGED',
  'property:$visible': 'SERIALIZED_ATTRIBUTES_CHANGED',
  'property:$casts': 'ATTRIBUTE_CAST_CHANGED',
});

export const LARAVEL_MODEL_ATTRIBUTES_INTERPRETER = Object.freeze({
  id: 'laravel-model-attributes',
  version: '1.0.0',
  interpret(fact) {
    if (!valueFactKinds.has(fact?.kind)) return { handled: false };

    const blocker = Object.hasOwn(modelAttributeProperties, fact?.properties?.container)
      ? modelAttributeProperties[fact.properties.container]
      : inReturnOf(fact, 'casts') ? 'ATTRIBUTE_CAST_CHANGED' : null;

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
