/**
 * 框架 preset `php-laravel`：Laravel 的 transaction、授權、middleware、row lock、validation、
 * model attributes 與資料刪除。callee 與 container 使用 fact schema v2 的結構化欄位。
 */
import { receiverIs, receiverLast, structuredCallee, structuredContainer } from '../../facts/structured.js';
import { groupMiddlewares, removedStrings } from './strings.js';

/**
 * 判斷 receiver 是否為資料庫連線（DB facade、`$db`、`$this->adminDB` 等）。
 *
 * @param {object} callee - structured callee。
 * @returns {boolean} 是否為 DB-like receiver。
 */
function isDatabaseReceiver(callee) {
  return /^(DB|\w*db|\w*DB|\w*connection|pdo)$/i.test(receiverLast(callee));
}

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

/** 名稱本身就表示刪除資料或 schema（`$user->forceDelete()`、`Model::truncate()`、`$table->dropColumn('x')`）。 */
const deletionMethods = new Set(['forceDelete', 'forceDeleteQuietly', 'truncate', 'dropColumn', 'dropColumns', 'dropIfExists', 'dropSoftDeletes', 'dropTimestamps']);
const schemaReceivers = ['Schema', 'Illuminate\\Support\\Facades\\Schema'];
const fileReceivers = ['Storage', 'File', 'Illuminate\\Support\\Facades\\Storage', 'Illuminate\\Support\\Facades\\File'];
const fileDeletionMethods = new Set(['delete', 'deleteDirectory', 'deleteDirectories', 'cleanDirectory']);
const databaseReceivers = ['DB', 'Illuminate\\Support\\Facades\\DB'];

export const LARAVEL_DATA_DELETION_INTERPRETER = Object.freeze({
  id: 'laravel-data-deletion',
  version: '1.0.0',
  interpret(fact) {
    const callee = structuredCallee(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_ADDED' || !callee) return { handled: false };

    // 一般的 `->delete()` 可能是 soft delete，不列入；`DB::delete(...)` 是 raw SQL。
    if (
      deletionMethods.has(callee.name)
      || (callee.kind === 'static' && receiverIs(callee, schemaReceivers) && ['drop', 'dropIfExists', 'dropAllTables'].includes(callee.name))
      || (callee.kind === 'static' && receiverIs(callee, fileReceivers) && fileDeletionMethods.has(callee.name))
      || (callee.kind === 'static' && receiverIs(callee, databaseReceivers) && callee.name === 'delete')
      || (callee.kind === 'function' && ['unlink', 'rmdir'].includes(callee.name))
    ) {
      return { handled: true, blockers: ['DATA_DELETION_ADDED'] };
    }
    return { handled: false };
  },
});

export const PHP_LARAVEL_PRESET = Object.freeze([
  TRANSACTION_BOUNDARY_INTERPRETER,
  AUTHORIZATION_GUARD_INTERPRETER,
  MIDDLEWARE_GUARD_INTERPRETER,
  ROW_LOCK_INTERPRETER,
  LARAVEL_VALIDATION_INTERPRETER,
  LARAVEL_MODEL_ATTRIBUTES_INTERPRETER,
  LARAVEL_DATA_DELETION_INTERPRETER,
]);
