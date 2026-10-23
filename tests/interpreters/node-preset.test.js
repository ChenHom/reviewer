import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../analyzers/ts/src/analyze.js';
import { interpretSemanticFacts, validateFactInterpreters } from '../../src/facts/interpreter.js';
import { ANNOTATION_INTERPRETER, DIRECTIVE_COMMENT_INTERPRETER } from '../../src/interpreters/core.js';
import { NODE_PRESET } from '../../src/interpreters/presets/node.js';
import { resolveInterpreters } from '../../src/interpreters/presets/index.js';

const interpreters = resolveInterpreters(['node'], { language: 'ts' });

/**
 * 以 TS analyzer 實際產生的 facts 執行 node preset，回傳 blocker 代碼（不含 FACT_UNHANDLED）與未處理的 fact 種類。
 *
 * @param {string} before - 變更前原始碼。
 * @param {string} after - 變更後原始碼。
 * @returns {{blockers: string[], unhandled: string[]}} 結果。
 */
function review(before, after) {
  const result = analyze({ path: 'src/a.ts', beforeSource: before, afterSource: after });
  assert.equal(result.ok, true, result.code);
  const assessment = interpretSemanticFacts(result.facts, interpreters);
  const kinds = new Map(result.facts.map((fact) => [fact.id, fact.kind]));
  return {
    blockers: [...new Set(assessment.blockers.filter((code) => !code.startsWith('FACT_UNHANDLED')))].sort(),
    unhandled: assessment.unhandledFactIds.map((id) => kinds.get(id)).sort(),
  };
}

const fn = (body) => `export async function f(app: any, req: any) {\n  ${body}\n}\n`;
const method = (decorators, body = 'return 1;') => `export class C {\n  ${decorators}\n  m() { ${body} }\n}\n`;
const field = (decorators) => `export class Dto {\n  ${decorators}\n  amount!: number;\n}\n`;

test('node preset 的 interpreter set 合法、id 唯一，只適用 ts', () => {
  assert.deepEqual(validateFactInterpreters(interpreters), { valid: true, errors: [] });
  const ids = interpreters.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(NODE_PRESET.every((interpreter) => ids.includes(interpreter.id)));
  assert.ok(!resolveInterpreters(['node'], { language: 'php' }).some(({ id }) => id.startsWith('node-')));
});

test('transaction：Prisma / TypeORM / knex / Sequelize / Mongoose 的邊界與 rollback 被移除', () => {
  const cases = [
    [fn('await prisma.$transaction(async (tx) => { await tx.a.update(x); });'), fn('await prisma.a.update(x);'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('await qr.startTransaction();\n  await qr.manager.save(x);\n  await qr.commitTransaction();'), fn('await qr.manager.save(x);'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('await this.dataSource.transaction(async (m) => { await m.save(x); });'), fn('await this.repo.save(x);'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('await session.withTransaction(async () => { await A.create([x], { session }); });'), fn('await A.create([x]);'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('return m.update(v, { where: { id }, transaction: t });'), fn('return m.update(v, { where: { id } });'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('return A.create([x], { session });'), fn('return A.create([x], {});'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn("return knex('a').transacting(trx).insert(x);"), fn("return knex('a').insert(x);"), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('await t.commit();\n  return 1;'), fn('return 1;'), 'TRANSACTION_BOUNDARY_REMOVED'],
    [fn('try { await x(); } catch (e) { await qr.rollbackTransaction(); throw e; }'), fn('try { await x(); } catch (e) { throw e; }'), 'TRANSACTION_ROLLBACK_REMOVED'],
    [fn('try { await x(); } catch (e) { await trx.rollback(); throw e; }'), fn('try { await x(); } catch (e) { throw e; }'), 'TRANSACTION_ROLLBACK_REMOVED'],
    [method('@Transactional()'), method(''), 'TRANSACTION_BOUNDARY_REMOVED'],
  ];
  for (const [before, after, blocker] of cases) assert.ok(review(before, after).blockers.includes(blocker), after);

  // tracing 的 transaction、`{ session: false }`、巢狀的 `transaction` key 不是資料庫 transaction。
  assert.deepEqual(review(fn('Sentry.startTransaction(x);\n  return 1;'), fn('return 1;')).blockers, []);
  assert.deepEqual(review(fn("return passport.authenticate('jwt', { session: false });"), fn("return passport.authenticate('jwt', {});")).blockers, []);
  assert.deepEqual(review(fn('return m.find({ where: { transaction: 1 } });'), fn('return m.find({ where: {} });')).blockers, []);
});

test('row lock：forUpdate / setLock 與 lock 選項被移除', () => {
  assert.deepEqual(review(fn("return trx('w').where({ id }).forUpdate().first();"), fn("return trx('w').where({ id }).first();")).blockers, ['ROW_LOCK_REMOVED']);
  assert.deepEqual(review(fn("return repo.createQueryBuilder('w').setLock('pessimistic_write').getOne();"), fn("return repo.createQueryBuilder('w').getOne();")).blockers, ['ROW_LOCK_REMOVED']);
  assert.deepEqual(review(fn("return repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });"), fn('return repo.findOne({ where: { id } });')).blockers, ['ROW_LOCK_REMOVED']);
  assert.deepEqual(review(fn('return m.findOne({ where: { id }, lock: t.LOCK.UPDATE, transaction: t });'), fn('return m.findOne({ where: { id }, transaction: t });')).blockers, ['ROW_LOCK_REMOVED']);
  assert.deepEqual(review(fn('return m.find({ where: { lock: 1 } });'), fn('return m.find({ where: {} });')).blockers, []);
});

test('middleware：路由的 middleware 參數被移除或換掉、app.use / addHook 被移除、Fastify hook 選項被移除', () => {
  const cases = [
    [fn("router.post('/refund', requireAuth, refund);"), fn("router.post('/refund', refund);")],
    [fn("router.post('/refund', requireAuth, refund);"), fn("router.post('/refund', optionalAuth, refund);")],
    [fn("adminRouter.delete('/u/:id', [auth, isAdmin], remove);"), fn("adminRouter.delete('/u/:id', [auth], remove);")],
    [fn("app.get('/me', passport.authenticate('jwt', { session: false }), me);"), fn("app.get('/me', me);")],
    [fn('app.use(helmet());\n  app.use(express.json());'), fn('app.use(express.json());')],
    [fn("app.use('/admin', adminAuth, adminRouter);"), fn("app.use('/admin', adminRouter);")],
    [fn("fastify.addHook('onRequest', verify);\n  return 1;"), fn('return 1;')],
    [fn("fastify.get('/x', { preHandler: [auth], schema }, h);"), fn("fastify.get('/x', { schema }, h);")],
    [fn("fastify.get('/x', { preHandler: [auth, rate] }, h);"), fn("fastify.get('/x', { preHandler: [rate] }, h);")],
    [fn('consumer.apply(AuthMiddleware).forRoutes(OrdersController);\n  return 1;'), fn('return 1;')],
    [fn("router.post('/a', requireRole('admin'), h);"), fn("router.post('/a', requireRole(level), h);")],
    [fn("fastify.get('/x', { preHandler: auth.verify }, h);"), fn("fastify.get('/x', { preHandler: noop() }, h);")],
    [fn("router.post('/refund', requireAuth, refund);"), fn("router.post('/refund', refund, requireAuth);")],
    [fn('app.use(helmet(), rateLimit);'), fn('app.use(rateLimit, helmet());')],
    // inline callback middleware：callback 本身不比對內容，但被移除的參數仍要產生 fact。
    [fn("router.post('/refund', (req, res, next) => { if (!req.user) return res.sendStatus(401); next(); }, refund);"), fn("router.post('/refund', refund);")],
    [fn("router.post('/refund', function (req, res, next) { next(); }, (req, res) => res.send(1));"), fn("router.post('/refund', (req, res) => res.send(1));")],
  ];
  for (const [before, after] of cases) assert.ok(review(before, after).blockers.includes('MIDDLEWARE_GUARD_REMOVED'), after);

  // 移除 callback 參數時檔案仍是 PARTIAL（callback 的內容沒有被解釋）。
  const inline = analyze({
    path: 'src/a.ts',
    beforeSource: fn("router.post('/refund', (req, res, next) => next(), refund);"),
    afterSource: fn("router.post('/refund', refund);"),
  });
  assert.equal(inline.complete, false);
  assert.deepEqual(inline.facts.map(({ kind, properties }) => `${kind}:${properties.callee.text}`).sort(), ['CALL_ARGUMENT_REMOVED:router.post', 'CALL_REMOVED:next']);

  // 路徑字串改變、新增 middleware、HTTP client（axios / api）的參數不是路由 middleware。
  assert.deepEqual(review(fn("router.post('/a', auth, h);"), fn("router.post('/b', auth, h);")).blockers, []);
  assert.deepEqual(review(fn("router.post('/a', h);"), fn("router.post('/a', auth, h);")).blockers, []);
  assert.deepEqual(review(fn("router.post('/a', auth, h);"), fn("router.post('/a', [auth, rate], h);")).blockers, []);
  assert.deepEqual(review(fn("router.get(['/a', '/b'], h);"), fn("router.get(['/a'], h);")).blockers, []);
  assert.deepEqual(review(fn("return axios.post('/a', body, config);"), fn("return axios.post('/a', config);")).blockers, []);
  assert.deepEqual(review(fn("return api.post('/a', body);"), fn("return api.post('/a');")).blockers, []);
  assert.deepEqual(review(fn('return Math.max(a, b);'), fn('return Math.max(b, a);')).blockers, ['ARGUMENTS_REORDERED']);
  assert.deepEqual(review(fn("return axios.post(url, body, config);"), fn("return axios.post(url, config, body);")).blockers, ['ARGUMENTS_REORDERED']);
});

test('授權：NestJS guard / role decorator、Public decorator、CASL 與 useGlobalGuards', () => {
  assert.deepEqual(review(method('@UseGuards(AuthGuard)\n  @Post()'), method('@Post()')).blockers, ['ANNOTATION_REMOVED', 'AUTHORIZATION_GUARD_REMOVED']);
  assert.deepEqual(review(method('@UseGuards(AuthGuard, RolesGuard)'), method('@UseGuards(AuthGuard)')).blockers, ['AUTHORIZATION_GUARD_REMOVED']);
  assert.deepEqual(review(method('@UseGuards(AuthGuard)'), method('@UseGuards(OptionalGuard)')).blockers, ['AUTHORIZATION_GUARD_REMOVED', 'VARIABLE_REFERENCE_CHANGED']);
  assert.deepEqual(review(method('@Get()'), method('@Public()\n  @Get()')).blockers, ['ANNOTATION_ADDED', 'AUTHORIZATION_GUARD_REMOVED']);
  assert.deepEqual(review(method("@Roles('admin')"), method("@Roles('user')")).blockers, ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.deepEqual(review(method('@Roles(Role.Admin)'), method('@Roles(Role.User)')).blockers, ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.deepEqual(review(method("@Roles('admin')"), method("@Roles('admin', 'support')")).blockers, ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.deepEqual(review(method("@Permissions({ resource: 'order' })"), method("@Permissions({ resource: 'user' })")).blockers, ['AUTHORIZATION_ABILITY_CHANGED']);
  assert.ok(review(method('@Roles(Role.Admin)'), method('')).blockers.includes('AUTHORIZATION_GUARD_REMOVED'));
  assert.ok(review(fn("ForbiddenError.from(ability).throwUnlessCan('update', order);\n  return 1;"), fn('return 1;')).blockers.includes('AUTHORIZATION_GUARD_REMOVED'));
  assert.ok(review(fn('app.useGlobalGuards(new AuthGuard());\n  await app.listen(3000);'), fn('await app.listen(3000);')).blockers.includes('AUTHORIZATION_GUARD_REMOVED'));

  // 新增 guard 不是 blocker（其他 decorator 的增減交給 core 的 ANNOTATION_*）。
  assert.deepEqual(review(method('@UseGuards(AuthGuard)'), method('@UseGuards(AuthGuard, RolesGuard)')).unhandled, ['CALL_ARGUMENT_ADDED']);
  assert.deepEqual(review(method('@Get()'), method('@Get()\n  @HttpCode(204)')).blockers, ['ANNOTATION_ADDED']);
});

test('token / 簽章驗證被移除', () => {
  const cases = [
    [fn('return jwt.verify(token, key);'), fn('return jwt.decode(token);')],
    [fn('const p = await this.jwtService.verifyAsync(token);\n  return p;'), fn('const p = this.jwtService.decode(token);\n  return p;')],
    [fn('const { payload } = await jwtVerify(token, key);\n  return payload;'), fn('const payload = decodeJwt(token);\n  return payload;')],
    [fn('const e = stripe.webhooks.constructEvent(body, sig, secret);\n  return e;'), fn('const e = JSON.parse(body);\n  return e;')],
    [fn("if (!crypto.timingSafeEqual(a, b)) throw new Error('x');\n  return 1;"), fn('return 1;')],
    [fn('await this.gateway.verifySignature(req);\n  return 1;'), fn('return 1;')],
  ];
  for (const [before, after] of cases) assert.ok(review(before, after).blockers.includes('SIGNATURE_VERIFICATION_REMOVED'), before);
  assert.deepEqual(review(fn('return cache.verify(x);'), fn('return x;')), { blockers: [], unhandled: ['CALL_REMOVED'] });
});

test('validation：zod / joi / class-validator / ValidationPipe / Fastify schema（不是單向門）', () => {
  const cases = [
    ['export const B = z.object({ amount: z.number().min(1) });\n', 'export const B = z.object({ amount: z.number().min(0) });\n'],
    ['export const B = z.object({ amount: z.number().min(1) });\n', 'export const B = z.object({ amount: z.number() });\n'],
    ['export const B = z.object({ amount: z.number(), note: z.string() });\n', 'export const B = z.object({ amount: z.number() });\n'],
    ['export const B = Joi.object({ a: Joi.string().required() });\n', 'export const B = Joi.object({ a: Joi.string() });\n'],
    [fn('const body = Body.parse(req.body);\n  return body;'), fn('const body = req.body;\n  return body;')],
    [fn('await validateOrReject(dto);\n  return dto;'), fn('return dto;')],
    [field('@IsInt()\n  @Min(1)'), field('@IsInt()')],
    [field('@Min(1)'), field('@Min(0)')],
    [field(''), field('@IsOptional()')],
    [method('@UsePipes(new ValidationPipe())'), method('')],
    [fn('app.useGlobalPipes(new ValidationPipe({ whitelist: true }));'), fn('app.useGlobalPipes(new ValidationPipe({ whitelist: false }));')],
    [fn('app.useGlobalPipes(new ValidationPipe());\n  await app.listen(3000);'), fn('await app.listen(3000);')],
    [fn("fastify.post('/x', { schema: { body: S } }, h);"), fn("fastify.post('/x', {}, h);")],
    [fn("fastify.post('/x', { schema: { body: S } }, h);"), fn("fastify.post('/x', { schema: { body: T } }, h);")],
  ];
  for (const [before, after] of cases) {
    const { blockers, unhandled } = review(before, after);
    assert.ok(blockers.includes('VALIDATION_RULE_CHANGED'), after);
    assert.deepEqual(unhandled.filter((kind) => kind !== 'CALL_ADDED' && kind !== 'CALL_REMOVED'), [], after);
  }
  assert.deepEqual(review(fn('return JSON.parse(x);'), fn('return x;')), { blockers: [], unhandled: ['CALL_REMOVED'] });
  assert.deepEqual(review(fn("return name.toLowerCase().trim();"), fn('return name.toLowerCase();')).unhandled, ['CALL_REMOVED']);
});

test('資料刪除：新增 deleteMany / repository delete / knex del / Sequelize destroy / 刪除檔案', () => {
  const add = (call) => review(fn('await save(x);'), fn(`await save(x);\n  await ${call};`)).blockers;
  for (const call of [
    'prisma.orderItem.deleteMany({ where: { orderId: id } })',
    'this.prisma.user.delete({ where: { id } })',
    'this.userRepository.delete(u.id)',
    'this.userModel.deleteOne({ _id: id })',
    'User.findByIdAndDelete(id)',
    "knex('b').where({ id }).del()",
    "knex('b').truncate()",
    'User.destroy({ where: { id } })',
    'queryRunner.dropTable("orders")',
    'fs.promises.rm(dir, { recursive: true })',
    'fs.unlinkSync(path)',
    'rm(path)',
    's3.deleteObject({ Bucket, Key })',
  ]) {
    assert.ok(add(call).includes('DATA_DELETION_ADDED'), call);
  }
  for (const call of ['cache.delete(key)', 'this.sessions.delete(id)', 'socket.destroy()', 'stream.destroy()', '_.truncate(s)', 'this.cacheManager.del(key)', 'axios.delete(url)']) {
    assert.ok(!add(call).includes('DATA_DELETION_ADDED'), call);
  }
  // 移除刪除呼叫不是資料刪除。
  assert.deepEqual(review(fn('await prisma.a.deleteMany();\n  return 1;'), fn('return 1;')).blockers, []);
});

test('core：decorator 增減與指示註解變更', () => {
  const annotation = (kind) => ({ id: 'a', kind, properties: { callee: { text: 'Injectable', name: 'Injectable', receiver: [], kind: 'function', optional: false }, value: '@Injectable()' } });
  assert.deepEqual(ANNOTATION_INTERPRETER.interpret(annotation('ANNOTATION_REMOVED')), { handled: true, blockers: ['ANNOTATION_REMOVED'] });
  assert.deepEqual(ANNOTATION_INTERPRETER.interpret(annotation('ANNOTATION_ADDED')), { handled: true, blockers: ['ANNOTATION_ADDED'] });
  assert.deepEqual(ANNOTATION_INTERPRETER.interpret({ id: 'b', kind: 'CALL_ADDED', properties: {} }), { handled: false });
  assert.deepEqual(review(fn('return x.y;'), fn('// @ts-ignore\n  return x.y;')).blockers, ['DIRECTIVE_COMMENT_CHANGED']);
  assert.deepEqual(DIRECTIVE_COMMENT_INTERPRETER.interpret({ id: 'c', kind: 'CALL_ADDED', properties: {} }), { handled: false });
});
