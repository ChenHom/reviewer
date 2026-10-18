#!/usr/bin/env node
/**
 * TS analyzer 的 CLI 入口：stdin 讀 `{ path, beforeSource, afterSource }` JSON，stdout 輸出結果 JSON。
 * 協定與 PHP analyzer 相同；缺少依賴（typescript）時回報 `TS_ANALYZER_DEPENDENCY_MISSING`。
 */
import { Buffer } from 'node:buffer';
import process from 'node:process';

/**
 * 輸出 JSON 並結束。
 *
 * @param {object} payload - 輸出。
 * @returns {void} 無回傳值。
 */
function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
}

let analyze;
try {
  ({ analyze } = await import('../src/analyze.js'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  respond({ ok: false, code: 'TS_ANALYZER_DEPENDENCY_MISSING', nodeVersion: process.version });
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  input = null;
}

if (
  !input
  || typeof input.path !== 'string'
  || input.path.trim() === ''
  || typeof input.beforeSource !== 'string'
  || typeof input.afterSource !== 'string'
) {
  respond({ ok: false, code: 'TS_ANALYZER_INPUT_INVALID', nodeVersion: process.version });
} else {
  respond({ ...analyze(input), nodeVersion: process.version });
}
