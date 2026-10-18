import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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

test('無法證明等價時為 COV-TS-001 的 PARTIAL_PARSE；JS 檔案的語言為 javascript', async () => {
  const changed = await adapter.analyze(request('export const a = 1;\n', 'export const a = 2;\n', 'src/a.js'));
  assert.deepEqual(validateAdapterResult(changed), { valid: true, errors: [] });
  assert.equal(changed.complete, false);
  assert.equal(changed.reasonCode, 'UNRECOGNIZED_TS_CHANGE');
  assert.equal(changed.obligations[0].reasonCode, 'UNRECOGNIZED_TS_CHANGE');
  assert.equal(changed.obligations[0].changedRegions[0].language, 'javascript');

  const directive = await adapter.analyze(request('f();\n', '// eslint-disable-next-line\nf();\n'));
  assert.equal(directive.reasonCode, 'DIRECTIVE_COMMENT_CHANGED');
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
