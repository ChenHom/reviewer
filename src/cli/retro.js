import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicReviewer } from '../ai/client.js';
import { parseProjectConfig } from '../config/project-config.js';
import { formatRetro } from '../retro/format.js';
import { computeRetroMetrics, loadReports, parseComments } from '../retro/metrics.js';
import { proposeImprovements } from '../retro/proposals.js';

const USAGE = `用法：reviewer retro --reports <dir|file> [--reports ...] [options]
（在 reviewer 的 checkout 中也可以執行 node bin/retro.js）

彙整一段期間內 reviewer review --out 產生的 JSON 報表，找出可以強化或精簡的地方。

  --reports <path>      報表檔案或目錄（目錄中所有 .json，不遞迴）；可重複
  --comments <file>     人工 review 留言（JSON Lines：{"pr","path","body","author"}）
  --standards <file>    codingstandards.md（統計 AI 引用了哪些條目）
  --config <file>       .reviewer.json（統計沒有觸發的單向門；AI 建議的規則以它為基礎驗證）
  --out-dir <dir>       寫出 retro.md、retro.json，以及（有 AI 建議時）reviewer.proposed.json、mutation-drafts.json
  --json                stdout 輸出 JSON（取代 markdown）

AI 建議（需要 ANTHROPIC_API_KEY）：
  --ai                  請 AI 提出 codingstandards.md 增刪、.reviewer.json 規則與 mutation case 草案
                        （規則以 .reviewer.json 的驗證器檢查；草案以機械審查確認會產生預期的原因代碼）
  --ai-model <id>       模型（預設 ${DEFAULT_MODEL}）
  --ai-effort <level>   low | medium | high | xhigh | max（預設 ${DEFAULT_EFFORT}）

建議都是草案：請人工審核後以 PR 提出，不會直接修改任何檔案。

exit code：0 完成；2 錯誤。`;

/**
 * 讀取可選的文字檔。
 *
 * @param {string|undefined} path - 路徑。
 * @returns {Promise<string|null>} 內容。
 */
async function optionalText(path) {
  return path === undefined ? null : readFile(path, 'utf8');
}

/**
 * 執行 `reviewer retro`。
 *
 * @param {string[]} args - 參數（不含指令名稱）。
 * @returns {Promise<void>} 完成；結果以 stdout、stderr 與 `process.exitCode` 表示。
 */
export async function run(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const { values } = parseArgs({
      args,
      options: {
        reports: { type: 'string', multiple: true },
        comments: { type: 'string' },
        standards: { type: 'string' },
        config: { type: 'string' },
        'out-dir': { type: 'string' },
        json: { type: 'boolean' },
        ai: { type: 'boolean' },
        'ai-model': { type: 'string' },
        'ai-effort': { type: 'string' },
      },
    });
    if (!values.reports?.length) throw new Error('OPTION_MISSING:--reports');
    const aiOptions = ['ai-model', 'ai-effort'].filter((name) => values[name] !== undefined);
    if (!values.ai && aiOptions.length > 0) throw new Error(`OPTION_REQUIRES_AI:--${aiOptions[0]}`);
    const reviewer = values.ai
      ? await createAnthropicReviewer({ model: values['ai-model'] ?? DEFAULT_MODEL, effort: values['ai-effort'] ?? DEFAULT_EFFORT })
      : null;

    const { reports, errors } = await loadReports(values.reports);
    if (reports.length === 0) throw new Error(`RETRO_NO_REPORTS${errors.length > 0 ? `:${errors.join(',')}` : ''}`);
    for (const error of errors) process.stderr.write(`warning: ${error}\n`);

    const [commentsText, standards, configText] = await Promise.all([
      optionalText(values.comments),
      optionalText(values.standards),
      optionalText(values.config),
    ]);
    let comments = null;
    if (commentsText !== null) {
      const parsed = parseComments(commentsText);
      for (const error of parsed.errors) process.stderr.write(`warning: ${error}\n`);
      comments = parsed.comments;
    }
    let config = null;
    if (configText !== null) {
      config = parseProjectConfig(configText);
      if (!config.valid) throw new Error(`RETRO_CONFIG_INVALID:${config.errors.join(',')}`);
    }

    const metrics = computeRetroMetrics(reports, { standards, config, comments });
    const proposals = reviewer
      ? await proposeImprovements({ reviewer, metrics, reports, standards, configText, comments: comments ?? [] })
      : null;
    const markdown = formatRetro(metrics, proposals);
    const json = `${JSON.stringify({ metrics, proposals }, null, 2)}\n`;

    if (values['out-dir']) {
      const dir = values['out-dir'];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'retro.md'), markdown);
      await writeFile(join(dir, 'retro.json'), json);
      if (proposals?.ok && proposals.proposedConfig) {
        await writeFile(join(dir, 'reviewer.proposed.json'), `${JSON.stringify(proposals.proposedConfig, null, 2)}\n`);
      }
      if (proposals?.ok && proposals.mutationCases.length > 0) {
        await writeFile(join(dir, 'mutation-drafts.json'), `${JSON.stringify(proposals.mutationCases, null, 2)}\n`);
      }
    }
    process.stdout.write(values.json ? json : markdown);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
