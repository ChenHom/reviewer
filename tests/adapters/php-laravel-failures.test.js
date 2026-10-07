import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';

import { validateAdapterResult } from '../../src/adapters/contracts.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';

const workDir = await mkdtemp(join(tmpdir(), 'php-adapter-failures-'));
after(() => rm(workDir, { recursive: true, force: true }));

const request = {
  path: 'app/Services/ExampleService.php',
  beforeSource: '<?php\n$a = 1;\n',
  afterSource: '<?php\n$a = 2;\n',
};

/**
 * 以 Node 腳本模擬 PHP analyzer，讓測試能控制 stdout / exit code。
 *
 * @param {string} name - script file name。
 * @param {string} body - Node script body。
 * @returns {Promise<object>} 使用 fake analyzer 的 adapter。
 */
async function fakeAnalyzerAdapter(name, body) {
  const analyzerPath = join(workDir, name);
  await writeFile(analyzerPath, body, 'utf8');
  return createPhpLaravelAdapter({ phpBinary: process.execPath, analyzerPath });
}

/**
 * 建立會輸出固定 JSON 的 fake analyzer。
 *
 * @param {string} name - script file name。
 * @param {object} output - analyzer JSON result。
 * @returns {Promise<object>} 使用 fake analyzer 的 adapter。
 */
function jsonAnalyzerAdapter(name, output) {
  return fakeAnalyzerAdapter(
    name,
    `process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(output))}));`,
  );
}

test('缺少 path 或 source 時回傳 PHP_ANALYZER_INPUT_INVALID 且不執行 analyzer', async () => {
  const adapter = createPhpLaravelAdapter({ phpBinary: '/nonexistent/php' });
  const invalidRequests = [
    undefined,
    { ...request, path: undefined },
    { ...request, path: '   ' },
    { ...request, beforeSource: null },
    { ...request, afterSource: 42 },
  ];

  for (const invalid of invalidRequests) {
    const result = await adapter.analyze(invalid);

    assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
    assert.equal(result.complete, false);
    assert.equal(result.reasonCode, 'PHP_ANALYZER_INPUT_INVALID');
    assert.equal(result.obligations[0].status, 'FAILED');
    assert.deepEqual(result.facts, []);
  }
});

test('afterSource 為空（刪除檔案）時回傳 UNSUPPORTED，不能視為安全', async () => {
  const adapter = createPhpLaravelAdapter({ phpBinary: '/nonexistent/php' });
  const result = await adapter.analyze({ ...request, afterSource: '' });

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.equal(result.obligations[0].status, 'UNSUPPORTED');
  assert.equal(result.reasonCode, 'PHP_FILE_DELETION_UNSUPPORTED');
});

test('analyzer 回傳 ok:false 時沿用其 code，缺 code 時 fallback 為 PHP_ANALYZER_FAILED', async () => {
  const withCode = await jsonAnalyzerAdapter('not-ok-code.js', {
    ok: false,
    code: 'PHP_PARSE_ERROR',
  });
  const withoutCode = await jsonAnalyzerAdapter('not-ok-bare.js', { ok: false });

  const first = await withCode.analyze(request);
  assert.deepEqual(validateAdapterResult(first), { valid: true, errors: [] });
  assert.equal(first.reasonCode, 'PHP_PARSE_ERROR');
  assert.equal(first.obligations[0].status, 'FAILED');

  const second = await withoutCode.analyze(request);
  assert.equal(second.reasonCode, 'PHP_ANALYZER_FAILED');
  assert.equal(second.complete, false);
});

test('analyzer 非零 exit code 會 reject 並帶出 stderr', async () => {
  const adapter = await fakeAnalyzerAdapter(
    'exit-nonzero.js',
    `process.stdin.resume();
process.stdin.on('end', () => { process.stderr.write('boom\\n'); process.exit(3); });`,
  );

  await assert.rejects(adapter.analyze(request), {
    message: 'PHP_ANALYZER_EXIT_3:boom',
  });
});

test('analyzer stdout 不是 JSON 時 reject PHP_ANALYZER_OUTPUT_INVALID', async () => {
  const adapter = await fakeAnalyzerAdapter(
    'invalid-json.js',
    `process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('not json'));`,
  );

  await assert.rejects(adapter.analyze(request), {
    message: 'PHP_ANALYZER_OUTPUT_INVALID',
  });
});

test('PHP binary 不存在時 reject spawn error', async () => {
  const adapter = createPhpLaravelAdapter({
    phpBinary: join(workDir, 'missing-php-binary'),
  });

  await assert.rejects(adapter.analyze(request), { code: 'ENOENT' });
});

test('abort signal 會終止 analyzer 並 reject PHP_ANALYZER_ABORTED', async () => {
  const adapter = await fakeAnalyzerAdapter(
    'hang.js',
    'process.stdin.resume(); setInterval(() => {}, 1000);',
  );
  const controller = new globalThis.AbortController();
  const pending = adapter.analyze(request, { signal: controller.signal });
  globalThis.setTimeout(() => controller.abort(), 50);

  await assert.rejects(pending, { message: 'PHP_ANALYZER_ABORTED' });
});

test('analyzer 缺 facts/diagnostics/reasonCode 時以 fail-closed 預設值補齊', async () => {
  const adapter = await jsonAnalyzerAdapter('sparse-partial.js', {
    ok: true,
    status: 'PARTIAL_PARSE',
    complete: false,
    phpVersion: '8.4.0',
  });
  const result = await adapter.analyze(request);

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.reasonCode, 'UNRECOGNIZED_PHP_CHANGE');
  assert.equal(result.obligations[0].reasonCode, 'UNRECOGNIZED_PHP_CHANGE');
  assert.equal(
    result.obligations[0].changedRegions[0].runtimeContext.version,
    '8.4.0',
  );
});

test('changed region endByte 以 UTF-8 byte 計算', async () => {
  const afterSource = '<?php\n$label = "付款";\n';
  const adapter = await jsonAnalyzerAdapter('complete.js', {
    ok: true,
    status: 'COMPLETE',
    complete: true,
    reasonCode: null,
    diagnostics: [],
    facts: [],
    phpVersion: '8.4.0',
  });
  const result = await adapter.analyze({ ...request, afterSource });

  assert.equal(result.complete, true);
  assert.equal(result.reasonCode, undefined);
  assert.equal(
    result.obligations[0].changedRegions[0].endByte,
    Buffer.byteLength(afterSource, 'utf8'),
  );
});

test('analyzer 缺少 Composer 依賴時以 PHP_ANALYZER_DEPENDENCY_MISSING fail-closed', async () => {
  const isolatedBin = join(workDir, 'isolated', 'bin');
  await mkdir(isolatedBin, { recursive: true });
  const analyzerPath = join(isolatedBin, 'analyze.php');
  await copyFile(
    fileURLToPath(new URL('../../analyzers/php/bin/analyze.php', import.meta.url)),
    analyzerPath,
  );
  const adapter = createPhpLaravelAdapter({ analyzerPath });
  const result = await adapter.analyze(request);

  assert.deepEqual(validateAdapterResult(result), { valid: true, errors: [] });
  assert.equal(result.complete, false);
  assert.equal(result.reasonCode, 'PHP_ANALYZER_DEPENDENCY_MISSING');
  assert.equal(result.obligations[0].status, 'FAILED');
});

test('analyzer 未讀取 stdin 就結束時，大型 payload 不會因 EPIPE 讓 process crash', async () => {
  const adapter = await fakeAnalyzerAdapter(
    'exit-without-reading.js',
    `process.stdout.write(JSON.stringify({ ok: false, code: 'PHP_ANALYZER_DEPENDENCY_MISSING' }));
process.exit(0);`,
  );
  const large = `<?php\n${'$x = 1;\n'.repeat(400_000)}`;
  const result = await adapter.analyze({ ...request, beforeSource: large, afterSource: large });

  assert.equal(result.complete, false);
  assert.equal(result.reasonCode, 'PHP_ANALYZER_DEPENDENCY_MISSING');
});
