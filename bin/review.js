#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicReviewer } from '../src/ai/client.js';
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
  --fail-on-human       有任何檔案需要人工（ESCALATED、AI 判斷需要人工或 AI 失敗；沒有 --ai 時
                        AI_TRACK 也算），或有尚未 commit 的 AI 修正時 exit code 為 1
  --concurrency <n>     同時執行的 analyzer 數（預設為 CPU 數，最多 8）
  --timeout-ms <n>      單一檔案的 analyzer deadline（預設 30000）

AI 審查（第 2 層，需要 ANTHROPIC_API_KEY）：
  --ai                  把 AI_TRACK 與 ESCALATED 檔案交給 AI 審查
  --ai-model <id>       模型（預設 ${DEFAULT_MODEL}）
  --ai-effort <level>   low | medium | high | xhigh | max（預設 ${DEFAULT_EFFORT}）
  --ai-apply            把 AI 對 AI_TRACK 檔案的修正寫入 worktree（不 commit；worktree 必須是乾淨的 head）
  --ai-concurrency <n>  同時進行的 AI 請求數（預設 4）
  --ai-max-files <n>    最多交給 AI 的檔案數，超過的檔案需要人工（預設 50）

流程：機械審查 → AI 審查剩下的 → AI 審查後需要人工的才交給人工。
路由：AUTO_PASS（不需要 review）、AI_TRACK（交給 AI 審查，由 AI 判斷是否需要人工）、
ESCALATED（單向門：AI 審查後必須人工確認）。

exit code：0 完成；1 需要 review（--fail-on-review）、命中單向門（--fail-on-escalation）或需要人工
（--fail-on-human）；2 錯誤。`;

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
        'fail-on-human': { type: 'boolean' },
        concurrency: { type: 'string' },
        'timeout-ms': { type: 'string' },
        ai: { type: 'boolean' },
        'ai-model': { type: 'string' },
        'ai-effort': { type: 'string' },
        'ai-apply': { type: 'boolean' },
        'ai-concurrency': { type: 'string' },
        'ai-max-files': { type: 'string' },
      },
    });
    if (!values.base) throw new Error('OPTION_MISSING:--base');
    const aiOptions = ['ai-model', 'ai-effort', 'ai-apply', 'ai-concurrency', 'ai-max-files'].filter((name) => values[name] !== undefined);
    if (!values.ai && aiOptions.length > 0) throw new Error(`OPTION_REQUIRES_AI:--${aiOptions[0]}`);
    const ai = values.ai
      ? {
        reviewer: await createAnthropicReviewer({ model: values['ai-model'] ?? DEFAULT_MODEL, effort: values['ai-effort'] ?? DEFAULT_EFFORT }),
        apply: Boolean(values['ai-apply']),
        concurrency: positiveInteger(values['ai-concurrency'], 4, 'ai-concurrency', 32),
        maxFiles: positiveInteger(values['ai-max-files'], 50, 'ai-max-files', 10_000),
      }
      : null;

    const report = await reviewRange({
      repo: values.repo,
      base: values.base,
      head: values.head,
      concurrency: positiveInteger(values.concurrency, Math.min(availableParallelism(), 8), 'concurrency', 64),
      timeoutMs: positiveInteger(values['timeout-ms'], 30_000, 'timeout-ms', 2_147_483_647),
      ai,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) {
      await mkdir(dirname(values.out), { recursive: true });
      await writeFile(values.out, json);
    }
    process.stdout.write(values.json ? json : `${formatReview(report)}\n`);
    if (values['fail-on-review'] && report.decision.status === HUMAN_REVIEW) process.exitCode = 1;
    if (values['fail-on-escalation'] && report.routing.track === TRACK.ESCALATED) process.exitCode = 1;
    if (values['fail-on-human'] && (report.human.required || report.human.pendingFixes > 0)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
