import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import { validateAdapterResult } from '../../src/adapters/contracts.js';
import { createTypeScriptAdapter } from '../../src/adapters/typescript/adapter.js';

const workDir = await mkdtemp(join(tmpdir(), 'ts-adapter-'));
after(() => rm(workDir, { recursive: true, force: true }));

const adapter = createTypeScriptAdapter();
const request = (beforeSource, afterSource, path = 'src/a.ts') => ({ path, beforeSource, afterSource });

test('等價的 TS 變更為 COMPLETE、沒有 fact，通過 AdapterResult 驗證', async () => {
  const result = await adapter.analyze(request("export const a = 'x'\n", 'export const a = "x";\n'));
  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.facts, []);
  assert.equal(result.obligations[0].id, 'COV-TS-001');
  assert.equal(result.obligations[0].status, 'COMPLETE');
  const [region] = result.obligations[0].changedRegions;
  assert.equal(region.language, 'typescript');
  assert.equal(region.adapterId, 'typescript-v1');
  assert.equal(region.runtimeContext.id, 'server:node');
});

test('結構變更產生 fact（含 scope hash 與 UTF-8 byte provenance）；JS 檔案的語言為 javascript', async () => {
  const changed = await adapter.analyze(request("const s = '中文';\nexport const a = 1;\n", "const s = '中文';\nexport const a = 2;\n", 'src/a.js'));
  assert.deepEqual(validateAdapterResult(changed), { valid: true, errors: [] });
  assert.equal(changed.complete, true);
  assert.equal(changed.obligations[0].status, 'COMPLETE');
  assert.equal(changed.obligations[0].changedRegions[0].language, 'javascript');
  const [fact] = changed.facts;
  assert.equal(fact.kind, 'LITERAL_CHANGED');
  assert.equal(fact.subject, 'src/a.js');
  assert.deepEqual(fact.properties.container, { type: 'const', name: 'a', keys: [], text: 'const:a' });
  assert.equal(fact.properties.scope.kind, 'file');
  assert.match(fact.properties.scope.hash, /^ts:[0-9a-f]{64}$/);
  // `中文` 是 6 個 byte：`2` 位於第 2 行 `export const a = ` 之後。
  const offset = Buffer.byteLength("const s = '中文';\nexport const a = ");
  assert.deepEqual(fact.provenance, { path: 'src/a.js', startByte: offset, endByte: offset + 1 });
  assert.deepEqual(fact.source, { adapterId: 'typescript-v1', adapterVersion: '0.3.0' });

  const method = (body) => `export class S {\n  handle(x: number) {\n    ${body}\n  }\n}\n`;
  const scoped = await adapter.analyze(request(method('return x < 10;'), method('return x <= 10;')));
  assert.equal(scoped.facts[0].kind, 'BINARY_OPERATOR_CHANGED');
  assert.equal(scoped.facts[0].subject, 'S.handle');
  assert.equal(scoped.facts[0].properties.scope.kind, 'function');
  // 同一個 method 只改排版時 scope hash 不變。
  const reformatted = await adapter.analyze(request(method('return x < 10;'), method('return x  <=  10 ;')));
  assert.equal(reformatted.facts[0].properties.scope.hash, scoped.facts[0].properties.scope.hash);

  const directive = await adapter.analyze(request('f();\n', '// eslint-disable-next-line\nf();\n'));
  assert.equal(directive.complete, true);
  assert.deepEqual(directive.facts.map(({ kind, properties }) => [kind, properties.comment, properties.changeSide]), [
    ['DIRECTIVE_COMMENT_CHANGED', '// eslint-disable-next-line', 'after'],
  ]);
});

test('無法解釋的變更為 COV-TS-001 的 PARTIAL_PARSE', async () => {
  const fn = (body) => `export function f(x) { ${body} }\n`;
  const changed = await adapter.analyze(request(fn('return (x + 1) * 2;'), fn('return x + 1 * 2;')));
  assert.deepEqual(validateAdapterResult(changed), { valid: true, errors: [] });
  assert.equal(changed.complete, false);
  assert.equal(changed.reasonCode, 'UNRECOGNIZED_TS_CHANGE');
  assert.equal(changed.obligations[0].status, 'PARTIAL_PARSE');
  assert.equal(changed.obligations[0].reasonCode, 'UNRECOGNIZED_TS_CHANGE');
});

test('語法錯誤、刪除與不合法輸入 fail-closed', async () => {
  const broken = await adapter.analyze(request('export const a = 1;\n', 'export const a = ;\n'));
  assert.equal(broken.reasonCode, 'TS_PARSE_ERROR');
  assert.equal(broken.obligations[0].status, 'FAILED');

  const deleted = await adapter.analyze(request('export const a = 1;\n', ''));
  assert.equal(deleted.reasonCode, 'TS_FILE_DELETION_UNSUPPORTED');
  assert.equal(deleted.obligations[0].status, 'UNSUPPORTED');

  const offline = createTypeScriptAdapter({ nodeBinary: '/nonexistent/node' });
  for (const invalid of [undefined, { ...request('a', 'b'), path: ' ' }, { ...request('a', 'b'), beforeSource: null }]) {
    assert.equal((await offline.analyze(invalid)).reasonCode, 'TS_ANALYZER_INPUT_INVALID');
  }
  await assert.rejects(offline.analyze(request('a', 'b')), /ENOENT/);
});

test('缺少 typescript 依賴時回報 TS_ANALYZER_DEPENDENCY_MISSING', async () => {
  const root = fileURLToPath(new URL('../../analyzers/ts/', import.meta.url));
  const copy = join(workDir, 'ts-without-deps');
  await cp(join(root, 'bin'), join(copy, 'bin'), { recursive: true });
  await cp(join(root, 'src'), join(copy, 'src'), { recursive: true });
  await writeFile(join(copy, 'package.json'), '{"type":"module"}');
  const result = await createTypeScriptAdapter({ analyzerPath: join(copy, 'bin', 'analyze.js') }).analyze(request('a', 'b'));
  assert.equal(result.reasonCode, 'TS_ANALYZER_DEPENDENCY_MISSING');
});

test('analyzer 的錯誤輸出與 abort 以 TS_ANALYZER_* 回報', async () => {
  const fake = async (name, body) => {
    const analyzerPath = join(workDir, name);
    await writeFile(analyzerPath, body);
    return createTypeScriptAdapter({ nodeBinary: process.execPath, analyzerPath });
  };
  const notJson = await fake('not-json.mjs', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('nope'));");
  await assert.rejects(notJson.analyze(request('a', 'b')), /TS_ANALYZER_OUTPUT_INVALID/);

  const failing = await fake('fail.mjs', 'process.exit(3);');
  await assert.rejects(failing.analyze(request('a', 'b')), /TS_ANALYZER_EXIT_3/);

  const slow = await fake('slow.mjs', 'setTimeout(() => {}, 10_000);');
  await assert.rejects(slow.analyze(request('a', 'b'), { signal: globalThis.AbortSignal.timeout(50) }), /TS_ANALYZER_ABORTED/);

  const empty = await fake('empty.mjs', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{\"ok\":false}'));");
  assert.equal((await empty.analyze(request('a', 'b'))).reasonCode, 'TS_ANALYZER_FAILED');

  const partial = await fake('partial.mjs', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true, status: 'PARTIAL_PARSE', complete: false })));");
  const partialResult = await partial.analyze(request('a', 'b'));
  assert.equal(partialResult.reasonCode, 'UNRECOGNIZED_TS_CHANGE');
  assert.deepEqual(partialResult.facts, []);
  assert.deepEqual(partialResult.diagnostics, []);
});
