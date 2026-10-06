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
  version: '1.1.0',
  interpret(fact) {
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

export const MIDDLEWARE_GUARD_INTERPRETER = Object.freeze({
  id: 'php-laravel-middleware-guard',
  version: '1.1.0',
  interpret(fact) {
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
      const remaining = new Set(stringLiterals(after));
      removed = stringLiterals(before).filter((name) => !remaining.has(name));
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

export const PHP_LARAVEL_DOMAIN_INTERPRETERS = Object.freeze([
  PAYMENT_IDEMPOTENCY_INTERPRETER,
  TRANSACTION_BOUNDARY_INTERPRETER,
  AUTHORIZATION_GUARD_INTERPRETER,
  MIDDLEWARE_GUARD_INTERPRETER,
  ROW_LOCK_INTERPRETER,
  SIGNATURE_VERIFICATION_INTERPRETER,
  OPERATOR_CHANGE_INTERPRETER,
  GUARD_CLAUSE_INTERPRETER,
]);
