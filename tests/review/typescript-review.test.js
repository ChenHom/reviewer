import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { formatReview } from '../../src/review/format.js';
import { reviewRange } from '../../src/review/review.js';

const run = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), 'review-ts-'));
after(() => rm(repo, { recursive: true, force: true }));

const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
const write = async (path, content) => {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), content);
};

test('TS / JS 檔案送進 TS analyzer：等價的變更不需 review，可解釋的變更為 TARGETED，無法解釋的為 FULL；.d.ts 不分析', async () => {
  await git('init', '-q');
  await write('src/format.ts', "export function f(x: number) { const total = x * 2; return { total, label: 'a' } }\n");
  await write('src/logic.js', 'export const limit = (x) => x < 10;\n');
  await write('src/types.d.ts', 'export type A = string;\n');
  await write('src/calc.ts', 'export const calc = (x: number) => (x + 1) * 2;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();

  await write('src/format.ts', 'export function f(x: number) {\n  const total = x * 2;\n  return { total, label: "a" };\n}\n');
  await write('src/logic.js', 'export const limit = (x) => x <= 10;\n');
  await write('src/types.d.ts', 'export type A = number;\n');
  await write('src/calc.ts', 'export const calc = (x: number) => x + 1 * 2;\n');
  await git('commit', '-q', '-am', 'head');

  const report = await reviewRange({ repo, base, head: 'HEAD' });
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));

  assert.equal(byPath['src/format.ts'].decision, 'NOT_SELECTED_FOR_HUMAN_REVIEW');
  assert.equal(byPath['src/format.ts'].track, 'AUTO_PASS');

  const logic = byPath['src/logic.js'];
  assert.equal(logic.analyzed, true);
  assert.equal(logic.fallback, 'TARGETED');
  assert.deepEqual(logic.reasons, ['COMPARISON_OPERATOR_CHANGED']);
  assert.equal(logic.facts[0].subject, 'limit');
  assert.equal(logic.facts[0].description, '運算子 < → <=：x < 10 → x <= 10');
  assert.equal(logic.track, 'AI_TRACK');

  const calc = byPath['src/calc.ts'];
  assert.equal(calc.fallback, 'FULL');
  assert.deepEqual(calc.reasons, ['COV-TS-001:UNRECOGNIZED_TS_CHANGE']);
  assert.equal(calc.track, 'AI_TRACK');

  assert.deepEqual(byPath['src/types.d.ts'].reasons, ['UNSUPPORTED_FILE_TYPE']);
  assert.match(formatReview(report), /COV-TS-001:UNRECOGNIZED_TS_CHANGE（有無法自動解釋的變更，請看整個檔案）/);
});
