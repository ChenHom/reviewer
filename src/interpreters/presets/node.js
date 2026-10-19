/**
 * 框架 preset `node`：Node.js 後端常見框架與函式庫（Express / Koa / Fastify / NestJS、Prisma /
 * TypeORM / Sequelize / knex / Mongoose、jsonwebtoken / jose、zod / joi / yup / class-validator）的
 * transaction、row lock、授權與 middleware、token / 簽章驗證、validation 與資料刪除。
 *
 * 只比對 fact schema v2 的結構化 callee / container，不解析語法字串；名稱判斷以「寧可多送人工」為原則，
 * 但 receiver 會盡量限縮（例如 `axios.post` 不是路由註冊、`map.delete` 不是資料刪除）。
 */
import { receiverLast, structuredCallee, structuredContainer } from '../../facts/structured.js';
import { signatureVerificationMethod } from './payments.js';

/**
 * 物件 key 去掉引號（TS fact 的 key 是原始碼文字：`'lock'` → `lock`）。
 *
 * @param {unknown} key - fact properties.key。
 * @returns {string} key。
 */
function bareKey(key) {
  return String(key ?? '').replace(/^(['"`])(.*)\1$/, '$2');
}

/**
 * receiver 路徑是否有任何一段符合 pattern。
 *
 * @param {object|null} callee - structured callee。
 * @param {RegExp} pattern - 比對的 pattern。
 * @returns {boolean} 是否符合。
 */
function receiverHas(callee, pattern) {
  return Array.isArray(callee?.receiver) && callee.receiver.some((segment) => pattern.test(segment));
}

/**
 * fact 的 container 為某個呼叫的位置參數時，回傳 `{container, callee}`；否則 null。
 *
 * @param {object} fact - semantic fact。
 * @returns {{container: object, callee: object}|null} 參數 container 與所屬呼叫。
 */
function argumentContainer(fact) {
  const container = structuredContainer(fact?.properties?.container);
  const callee = structuredCallee(container?.callee);
  return container?.type === 'argument' && typeof container.argument === 'number' && callee ? { container, callee } : null;
}

/**
 * fact 是否為呼叫參數中最外層物件的成員（選項物件：`findOne({ where, lock })` 的 `lock`，
 * 不含 `where: { lock: 1 }` 這種巢狀 key）。
 *
 * @param {object} fact - semantic fact。
 * @returns {boolean} 是否為選項。
 */
function isOption(fact) {
  return argumentContainer(fact)?.container.keys.length === 0;
}

const valueFactKinds = new Set([
  'LITERAL_CHANGED',
  'VARIABLE_CHANGED',
  'ARRAY_ITEM_REMOVED',
  'ARRAY_ITEM_ADDED',
  'EXPRESSION_NEGATED',
  'BINARY_OPERATOR_CHANGED',
]);
const argumentFactKinds = new Set(['CALL_ARGUMENT_REMOVED', 'CALL_ARGUMENT_ADDED', 'CALL_ARGUMENT_CHANGED', 'CALL_ARGUMENTS_REORDERED']);

/**
 * fact 影響到的呼叫：參數增減 / 改變的 callee，或值變更所在參數的 callee。
 *
 * @param {object} fact - semantic fact。
 * @returns {{callee: object, argument: number|null, keys: string[]}|null} 呼叫與參數位置。
 */
function touchedCall(fact) {
  if (argumentFactKinds.has(fact?.kind)) {
    const callee = structuredCallee(fact.properties?.callee);
    return callee ? { callee, argument: typeof fact.properties.argument === 'number' ? fact.properties.argument : null, keys: [] } : null;
  }
  if (!valueFactKinds.has(fact?.kind)) return null;
  const found = argumentContainer(fact);
  return found ? { callee: found.callee, argument: found.container.argument, keys: found.container.keys } : null;
}

// ---------------------------------------------------------------------------------------------
// Transaction

/** 資料庫連線、ORM 與 transaction 物件。 */
const databaseReceiver = /^(prisma|db|database|knex|sequelize|mongoose|orm|em|entityManager|manager|dataSource|connection|conn|pool|client|queryRunner|\w*(Db|DB|Connection|DataSource|Manager|QueryRunner))$/;
const transactionReceiver = /^(t|tx|trx|txn|transaction|session|\w*(Tx|Trx|Transaction|Session))$/;
/** tracing / APM 的「transaction」不是資料庫 transaction。 */
const tracingReceiver = /sentry|tracer|apm|newrelic|datadog|elastic|span/i;

const transactionStartMethods = new Set(['$transaction', 'startTransaction', 'beginTransaction', 'withTransaction', 'commitTransaction', 'transacting']);
const transactionRollbackMethods = new Set(['rollbackTransaction', 'abortTransaction']);
const transactionDecorators = new Set(['Transactional', 'Transaction']);

export const NODE_TRANSACTION_INTERPRETER = Object.freeze({
  id: 'node-transaction-boundary',
  version: '1.0.0',
  interpret(fact) {
    // `@Transactional()`（typeorm-transactional 等）被移除。
    if (fact?.kind === 'ANNOTATION_REMOVED' && transactionDecorators.has(structuredCallee(fact.properties?.callee)?.name)) {
      return { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED'] };
    }
    // Sequelize `{ transaction: t }`、Mongoose `{ session }` 選項被移除：查詢不再屬於 transaction。
    // `{ session: false }`（passport）不是 transaction。
    if (fact?.kind === 'ARRAY_ITEM_REMOVED' && isOption(fact)) {
      const key = bareKey(fact.properties.key);
      if (key === 'transaction' || (key === 'session' && !/^(true|false|null|undefined|\d.*|['"`].*)$/.test(String(fact.properties.value ?? '')))) {
        return { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED'] };
      }
    }

    const callee = structuredCallee(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_REMOVED' || !callee || receiverHas(callee, tracingReceiver)) return { handled: false };

    const last = receiverLast(callee);
    if (
      transactionStartMethods.has(callee.name)
      || (callee.name === 'transaction' && (callee.receiver === null || databaseReceiver.test(last)))
      || (callee.name === 'commit' && (databaseReceiver.test(last) || transactionReceiver.test(last)))
    ) {
      return { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED'] };
    }
    if (
      transactionRollbackMethods.has(callee.name)
      || (callee.name === 'rollback' && (databaseReceiver.test(last) || transactionReceiver.test(last)))
    ) {
      return { handled: true, blockers: ['TRANSACTION_ROLLBACK_REMOVED'] };
    }
    return { handled: false };
  },
});

// ---------------------------------------------------------------------------------------------
// Row lock

const rowLockMethods = new Set(['forUpdate', 'forShare', 'forNoKeyUpdate', 'forKeyShare', 'setLock', 'lockInShareMode']);
const rowLockOptions = new Set(['lock', 'lockMode']);

export const NODE_ROW_LOCK_INTERPRETER = Object.freeze({
  id: 'node-row-lock',
  version: '1.0.0',
  interpret(fact) {
    // knex `.forUpdate()`、TypeORM `.setLock(...)` 被移除。
    if (fact?.kind === 'CALL_REMOVED' && rowLockMethods.has(structuredCallee(fact.properties?.callee)?.name)) {
      return { handled: true, blockers: ['ROW_LOCK_REMOVED'] };
    }
    // TypeORM / Sequelize / MikroORM 的 `{ lock: ... }` / `{ lockMode: ... }` 選項被移除。
    if (fact?.kind === 'ARRAY_ITEM_REMOVED' && isOption(fact) && rowLockOptions.has(bareKey(fact.properties.key))) {
      return { handled: true, blockers: ['ROW_LOCK_REMOVED'] };
    }
    return { handled: false };
  },
});

// ---------------------------------------------------------------------------------------------
// Authorization 與 middleware

/** Express / Koa / Fastify 的 app 或 router。 */
const routerReceiver = /^(app|server|router|routes|fastify|\w*(Router|App|Routes))$/;
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head', 'use']);
/** Fastify 在 handler 之前執行的 hook（認證、授權、驗證通常掛在這裡）。 */
const routeHookOptions = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler']);
const routeHookPattern = /\b(onRequest|preParsing|preValidation|preHandler)\b/;

/**
 * `app.post(...)` / `router.use(...)` / `fastify.get(...)` 等路由註冊。
 *
 * @param {object|null} callee - structured callee。
 * @returns {boolean} 是否為路由註冊。
 */
function isRouteRegistration(callee) {
  return callee?.kind === 'method' && routeMethods.has(callee.name) && routerReceiver.test(receiverLast(callee));
}

/**
 * 路由註冊中除了路徑之外的參數（middleware、選項、handler）。
 *
 * @param {object} callee - structured callee。
 * @param {number|null} argument - 參數位置。
 * @param {unknown} value - 參數原始碼。
 * @returns {boolean} 是否為 middleware 位置。
 */
function isRouteMiddlewareArgument(callee, argument, value) {
  if (argument === null) return false;
  // 第一個參數是字串時是路徑；`app.use(auth)` 的第一個參數就是 middleware。
  if (/^\s*['"`]/.test(String(value ?? ''))) return false;
  return callee.name === 'use' || argument >= 1;
}

/**
 * before 有、after 沒有的 identifier（`[auth, rate]` → `[rate]` 移除 `auth`）。
 *
 * @param {unknown} before - 變更前原始碼。
 * @param {unknown} after - 變更後原始碼。
 * @returns {string[]} 被移除的 identifier。
 */
function removedIdentifiers(before, after) {
  const identifiers = (text) => String(text ?? '').match(/[A-Za-z_$][\w$]*/g) ?? [];
  const remaining = new Set(identifiers(after));
  return identifiers(before).filter((name) => !remaining.has(name));
}

/** NestJS 等的授權 decorator：移除時 endpoint 不再檢查權限。 */
const authorizationDecorators = new Set([
  'UseGuards', 'Roles', 'Role', 'Permissions', 'RequirePermissions', 'RequireRoles', 'HasRoles', 'Scopes',
  'Auth', 'Authorize', 'Authorized', 'CheckPolicies', 'CheckAbilities', 'Can',
]);
/** 讓 endpoint 略過認證 / 授權的 decorator：新增時等同移除防護。 */
const publicDecorators = new Set(['Public', 'IsPublic', 'AllowAnonymous', 'Anonymous', 'SkipAuth', 'NoAuth', 'Unprotected']);
/** 權限內容的 decorator：參數改變表示需要的權限改變。 */
const abilityDecorators = new Set(['Roles', 'Role', 'Permissions', 'RequirePermissions', 'RequireRoles', 'HasRoles', 'Scopes', 'CheckPolicies', 'CheckAbilities', 'Can']);
/** 授權檢查呼叫（CASL、自訂 helper）。 */
const authorizationCalls = new Set(['authorize', 'throwUnlessCan', 'assertCan', 'checkPermission', 'checkPermissions', 'requirePermission', 'ensureAuthorized']);

/**
 * 呼叫是否為 decorator 形式的 function（`@Roles(...)` 的 `Roles`）。
 *
 * @param {object|null} callee - structured callee。
 * @param {function(string): boolean} matches - 名稱比對。
 * @returns {boolean} 是否符合。
 */
function isDecoratorCall(callee, matches) {
  return callee?.kind === 'function' && Array.isArray(callee.receiver) && callee.receiver.length === 0 && matches(callee.name);
}

export const NODE_AUTHORIZATION_INTERPRETER = Object.freeze({
  id: 'node-authorization-guard',
  version: '1.0.0',
  interpret(fact) {
    const kind = fact?.kind;
    const annotation = structuredCallee(fact?.properties?.callee);
    if (kind === 'ANNOTATION_REMOVED' && authorizationDecorators.has(annotation?.name)) {
      return { handled: true, blockers: ['AUTHORIZATION_GUARD_REMOVED'] };
    }
    if (kind === 'ANNOTATION_ADDED' && publicDecorators.has(annotation?.name)) {
      return { handled: true, blockers: ['AUTHORIZATION_GUARD_REMOVED'] };
    }
    if (kind === 'CALL_REMOVED' && annotation) {
      if (authorizationCalls.has(annotation.name)) return { handled: true, blockers: ['AUTHORIZATION_GUARD_REMOVED'] };
      // NestJS `app.useGlobalGuards(...)` 被移除。
      if (annotation.name === 'useGlobalGuards') return { handled: true, blockers: ['AUTHORIZATION_GUARD_REMOVED'] };
    }

    const touched = touchedCall(fact);
    if (!touched) return { handled: false };
    // `@UseGuards(AuthGuard, RolesGuard)` 移除或換掉一個 guard（新增 guard 不是 blocker）。
    if (isDecoratorCall(touched.callee, (name) => name === 'UseGuards')) {
      return touched.keys.length === 0 && ['CALL_ARGUMENT_REMOVED', 'CALL_ARGUMENT_CHANGED', 'VARIABLE_CHANGED'].includes(kind)
        ? { handled: true, blockers: ['AUTHORIZATION_GUARD_REMOVED'] }
        : { handled: false };
    }
    // `@Roles('admin')` → `@Roles('user')`、增減一個 role：需要的權限改變。
    if (isDecoratorCall(touched.callee, (name) => abilityDecorators.has(name))) {
      return { handled: true, blockers: ['AUTHORIZATION_ABILITY_CHANGED'] };
    }
    return { handled: false };
  },
});

export const NODE_MIDDLEWARE_INTERPRETER = Object.freeze({
  id: 'node-middleware-guard',
  version: '1.0.0',
  interpret(fact) {
    const kind = fact?.kind;
    const callee = structuredCallee(fact?.properties?.callee);

    if (kind === 'CALL_REMOVED' && callee) {
      // `app.use(helmet())`、`fastify.addHook('preHandler', ...)`、Nest `consumer.apply(...)`、
      // `passport.authenticate(...)` 被移除。
      if (
        (callee.kind === 'method' && ['use', 'addHook'].includes(callee.name) && routerReceiver.test(receiverLast(callee)))
        || (callee.name === 'apply' && receiverLast(callee) === 'consumer')
        || (callee.name === 'authenticate' && receiverLast(callee) === 'passport')
      ) {
        return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
      }
      return { handled: false };
    }

    // `router.post('/refund', requireAuth, refund)` → `router.post('/refund', refund, requireAuth)`：
    // handler 依序執行，前面的 handler 回應後，換到後面的 middleware 就不會執行。
    if (kind === 'CALL_ARGUMENTS_REORDERED' && isRouteRegistration(callee)) {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }
    // `router.post('/refund', requireAuth, refund)` 移除 `requireAuth`。
    if (kind === 'CALL_ARGUMENT_REMOVED' && isRouteRegistration(callee)) {
      return isRouteMiddlewareArgument(callee, fact.properties.argument, fact.properties.value)
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }
    // `requireAuth` 換成 `optionalAuth`：原本的 middleware 不再套用。選項物件（Fastify）只在含有 hook 時才算。
    if (kind === 'CALL_ARGUMENT_CHANGED' && isRouteRegistration(callee)) {
      const before = String(fact.properties.before ?? '');
      return isRouteMiddlewareArgument(callee, fact.properties.argument, before)
        && (!before.trimStart().startsWith('{') || routeHookPattern.test(before))
        && removedIdentifiers(before, fact.properties.after).length > 0
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }

    const found = argumentContainer(fact);
    if (!found || !isRouteRegistration(found.callee)) return { handled: false };
    const { container } = found;
    if (kind === 'VARIABLE_CHANGED' && container.keys.length === 0) {
      return isRouteMiddlewareArgument(found.callee, container.argument, fact.properties.before)
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }
    // `router.delete('/u/:id', [auth, isAdmin], remove)` 的 middleware 陣列中移除一個元素。
    if (kind === 'ARRAY_ITEM_REMOVED' && container.keys.length === 0 && fact.properties.key === null) {
      return isRouteMiddlewareArgument(found.callee, container.argument, fact.properties.value)
        ? { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] }
        : { handled: false };
    }
    // Fastify 路由選項：`{ preHandler: [auth] }` 整個移除，或 `preHandler` 陣列中移除一個元素 / 換掉。
    if (kind === 'ARRAY_ITEM_REMOVED' && container.keys.length === 0 && routeHookOptions.has(bareKey(fact.properties.key))) {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }
    if (['ARRAY_ITEM_REMOVED', 'VARIABLE_CHANGED'].includes(kind) && container.keys.length > 0 && routeHookOptions.has(container.keys[0])) {
      return { handled: true, blockers: ['MIDDLEWARE_GUARD_REMOVED'] };
    }
    return { handled: false };
  },
});

// ---------------------------------------------------------------------------------------------
// Token / 簽章驗證

const verificationCalls = new Set(['jwtVerify', 'timingSafeEqual', 'constructEvent', 'constructEventAsync', 'verifyIdToken', 'compactVerify', 'flattenedVerify', 'generalVerify']);
const verifyMethods = new Set(['verify', 'verifyAsync', 'verifySync']);
const verifierReceiver = /jwt|jose|jws|crypto|token|sign|verif|hmac|webhook|svix/i;

export const NODE_TOKEN_VERIFICATION_INTERPRETER = Object.freeze({
  id: 'node-token-verification',
  version: '1.0.0',
  interpret(fact) {
    const callee = structuredCallee(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_REMOVED' || !callee) return { handled: false };
    // `jwt.verify` / `this.jwtService.verifyAsync` / jose `jwtVerify` / `crypto.timingSafeEqual` /
    // Stripe `webhooks.constructEvent` 被移除（例如改成只 decode 不驗簽）。
    if (
      verificationCalls.has(callee.name)
      || (verifyMethods.has(callee.name) && (callee.receiver === null || receiverHas(callee, verifierReceiver)))
      || signatureVerificationMethod.test(callee.name)
    ) {
      return { handled: true, blockers: ['SIGNATURE_VERIFICATION_REMOVED'] };
    }
    return { handled: false };
  },
});

// ---------------------------------------------------------------------------------------------
// Validation

/** zod / joi / yup / valibot / TypeBox 的 builder。 */
const schemaBuilders = /^(z|zod|Joi|joi|yup|Yup|valibot)$/;
/**
 * schema 鏈上的規則 method（`z.number().min(1)` 的 `.min`）；鏈的中段沒有 receiver，因此只列出
 * 不常出現在一般鏈式呼叫的名稱（`trim`、`includes`、`startsWith` 等字串 / 陣列 method 不列入）。
 */
const schemaChainRules = new Set([
  'min', 'max', 'length', 'gt', 'gte', 'lt', 'lte', 'positive', 'negative', 'nonnegative', 'nonpositive', 'int', 'integer',
  'finite', 'safe', 'multipleOf', 'precision', 'email', 'url', 'uuid', 'cuid', 'cuid2', 'ulid', 'regex', 'pattern',
  'nonempty', 'optional', 'nullable', 'nullish', 'required', 'notRequired', 'strict', 'passthrough', 'strip', 'catchall',
  'refine', 'superRefine', 'valid', 'invalid', 'allow', 'oneOf', 'notOneOf', 'datetime', 'ip',
]);
/** class-validator 的 decorator。 */
const validatorDecorator = /^(Is[A-Z]\w*|Min|Max|MinLength|MaxLength|Length|Matches|Contains|NotContains|Equals|NotEquals|ArrayMinSize|ArrayMaxSize|ArrayNotEmpty|ArrayUnique|ArrayContains|ValidateNested|ValidateIf|Allow)$/;
const parseCalls = new Set(['safeParse', 'parseAsync', 'safeParseAsync', 'validateOrReject', 'validateSync', 'validateAsync']);
const schemaReceiver = /(schema|validator|dto|body|input|payload|query|params)$/i;

/**
 * 呼叫是否為 schema 規則：builder 呼叫（`z.object`、`Joi.string`）、鏈上的規則 method、
 * class-validator decorator，或 NestJS `new ValidationPipe(...)`。
 *
 * @param {object|null} callee - structured callee。
 * @returns {boolean} 是否為 schema 規則。
 */
function isSchemaCall(callee) {
  if (!callee) return false;
  if (callee.kind === 'method') {
    return (callee.receiver?.length === 1 && schemaBuilders.test(callee.receiver[0]))
      || (callee.receiver === null && schemaChainRules.has(callee.name));
  }
  if (callee.kind === 'constructor') return callee.name === 'ValidationPipe';
  return isDecoratorCall(callee, (name) => validatorDecorator.test(name));
}

export const NODE_VALIDATION_INTERPRETER = Object.freeze({
  id: 'node-validation-rules',
  version: '1.0.0',
  interpret(fact) {
    const kind = fact?.kind;
    const callee = structuredCallee(fact?.properties?.callee);

    // class-validator decorator 增減（`@Min(1)`、`@IsEmail()`、`@IsOptional()`）、`@UsePipes(...)` 被移除。
    if (['ANNOTATION_REMOVED', 'ANNOTATION_ADDED'].includes(kind)) {
      return callee && (validatorDecorator.test(callee.name) || (kind === 'ANNOTATION_REMOVED' && callee.name === 'UsePipes'))
        ? { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] }
        : { handled: false };
    }
    if (['CALL_REMOVED', 'CALL_ADDED'].includes(kind) && callee) {
      if (
        isSchemaCall(callee)
        || (kind === 'CALL_REMOVED' && (
          parseCalls.has(callee.name)
          || (['parse', 'validate'].includes(callee.name) && schemaReceiver.test(receiverLast(callee)))
          || callee.name === 'useGlobalPipes'
        ))
      ) {
        return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };
      }
      return { handled: false };
    }

    const touched = touchedCall(fact);
    if (touched && isSchemaCall(touched.callee)) return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };

    // Fastify 路由的 `schema` 選項被移除或改變。
    if (kind === 'CALL_ARGUMENT_CHANGED' && isRouteRegistration(callee) && /\bschema\b/.test(`${fact.properties.before} ${fact.properties.after}`)) {
      return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };
    }
    const found = argumentContainer(fact);
    if (
      found
      && isRouteRegistration(found.callee)
      && (found.container.keys[0] === 'schema' || (found.container.keys.length === 0 && kind === 'ARRAY_ITEM_REMOVED' && bareKey(fact.properties.key) === 'schema'))
    ) {
      return { handled: true, blockers: ['VALIDATION_RULE_CHANGED'] };
    }
    return { handled: false };
  },
});

// ---------------------------------------------------------------------------------------------
// 資料刪除

/** 名稱本身就表示刪除資料（不論 receiver）。 */
const deletionCalls = new Set([
  'deleteMany', 'bulkDelete', 'dropTable', 'dropTableIfExists', 'dropColumn', 'dropColumns', 'dropDatabase', 'dropSchema',
  'dropCollection', 'findOneAndDelete', 'findByIdAndDelete', 'findOneAndRemove', 'findByIdAndRemove', 'deleteById',
  'deleteObject', 'deleteObjects', 'deleteBucket', 'rimraf', 'rimrafSync',
]);
/** 在資料庫、ORM、repository、model 上才表示刪除資料。 */
const recordDeletionMethods = new Set(['delete', 'deleteOne', 'remove', 'destroy', 'clear', 'del', 'truncate']);
const recordReceiver = /^(prisma|db|database|tx|trx|knex|orm|em|entityManager|manager|queryRunner|dataSource|sequelize|mongoose|\w*(Repository|Repo|Model|Collection|Table|Dao|Db|DB))$/;
const fileReceiver = /^(fs|fsp|fsPromises|promises|fse|fsExtra)$/;
const fileDeletionMethods = new Set(['rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync', 'truncate', 'truncateSync']);

export const NODE_DATA_DELETION_INTERPRETER = Object.freeze({
  id: 'node-data-deletion',
  version: '1.0.0',
  interpret(fact) {
    const callee = structuredCallee(fact?.properties?.callee);
    if (fact?.kind !== 'CALL_ADDED' || !callee) return { handled: false };

    const last = receiverLast(callee);
    if (
      deletionCalls.has(callee.name)
      // knex `.where(...).del()` / `.truncate()`：鏈的中段沒有 receiver。
      || (['del', 'truncate'].includes(callee.name) && callee.receiver === null)
      || (recordDeletionMethods.has(callee.name) && receiverHas(callee, recordReceiver))
      // Sequelize `User.destroy({ where })`。
      || (callee.name === 'destroy' && /^[A-Z]\w*$/.test(last) && callee.receiver.length === 1)
      // `fs.promises.rm(dir)`、`fs.unlinkSync(path)`、從 `fs/promises` import 的 `rm(path)`。
      || (fileDeletionMethods.has(callee.name) && (fileReceiver.test(last) || (callee.kind === 'function' && callee.receiver?.length === 0 && /^(rm|unlink|rmdir)(Sync)?$/.test(callee.name))))
    ) {
      return { handled: true, blockers: ['DATA_DELETION_ADDED'] };
    }
    return { handled: false };
  },
});

export const NODE_PRESET = Object.freeze([
  NODE_TRANSACTION_INTERPRETER,
  NODE_ROW_LOCK_INTERPRETER,
  NODE_AUTHORIZATION_INTERPRETER,
  NODE_MIDDLEWARE_INTERPRETER,
  NODE_TOKEN_VERIFICATION_INTERPRETER,
  NODE_VALIDATION_INTERPRETER,
  NODE_DATA_DELETION_INTERPRETER,
]);
