#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { formatReview } from '../src/review/format.js';
import { HUMAN_REVIEW, reviewRange } from '../src/review/review.js';
import { TRACK } from '../src/routing.js';

const USAGE = `用法：node bin/review.js --base <ref> [--head HEAD] [--repo .] [options]

Review head 相對於 base 的變更（與 GitHub PR 相同，從兩者的 merge base 算起），
列出需要 Human Review 的檔案與原因。

  --base <ref>          PR 的目標分支（例如 origin/master）
  --head <ref>          要 review 的版本（預設 HEAD）
  --repo <path>         git repository 路徑（預設目前目錄）
  --json                輸出 JSON 報表
  --out <file>          另外把 JSON 報表寫到檔案
  --fail-on-review      有任何檔案需要 Human Review 時 exit code 為 1
  --fail-on-escalation  有任何檔案命中單向門（路由為 ESCALATED，AI 審查後必須人工確認）時 exit code 為 1
  --concurrency <n>     同時執行的 analyzer 數（預設為 CPU 數，最多 8）
  --timeout-ms <n>      單一檔案的 analyzer deadline（預設 30000）

流程：機械審查 → AI 審查剩下的 → AI 審查後需要人工的才交給人工。
路由：AUTO_PASS（不需要 review）、AI_TRACK（交給 AI 審查，由 AI 判斷是否需要人工）、
ESCALATED（單向門：AI 審查後必須人工確認）。

exit code：0 完成；1 需要 review（--fail-on-review）或命中單向門（--fail-on-escalation）；2 錯誤。`;

/**
 * 解析正整數參數。
 *
 * @param {string|undefined} value - CLI 值。
 * @param {number} fallback - 預設值。
 * @param {string} name - 參數名稱。
 * @param {number} max - 上限。
 * @returns {number} 數值。
 */
function positiveInteger(value, fallback, name, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`OPTION_INVALID:--${name} ${value}`);
  return parsed;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
} else {
  try {
    const { values } = parseArgs({
      args,
      options: {
        base: { type: 'string' },
        head: { type: 'string', default: 'HEAD' },
        repo: { type: 'string', default: '.' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        'fail-on-review': { type: 'boolean' },
        'fail-on-escalation': { type: 'boolean' },
        concurrency: { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    });
    if (!values.base) throw new Error('OPTION_MISSING:--base');

    const report = await reviewRange({
      repo: values.repo,
      base: values.base,
      head: values.head,
      concurrency: positiveInteger(values.concurrency, Math.min(availableParallelism(), 8), 'concurrency', 64),
      timeoutMs: positiveInteger(values['timeout-ms'], 30_000, 'timeout-ms', 2_147_483_647),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) {
      await mkdir(dirname(values.out), { recursive: true });
      await writeFile(values.out, json);
    }
    process.stdout.write(values.json ? json : `${formatReview(report)}\n`);
    if (values['fail-on-review'] && report.decision.status === HUMAN_REVIEW) process.exitCode = 1;
    if (values['fail-on-escalation'] && report.routing.track === TRACK.ESCALATED) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
