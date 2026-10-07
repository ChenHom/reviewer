import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { prepareBaseline } from './baseline.js';
import { applyEdits, parseJsonl, parseRepoOptions, sha256 } from './corpus.js';
import {
  compareResults,
  formatComparison,
  formatSummary,
  summarizeResults,
  validateResults,
} from './metrics.js';
import { REVIEWER_ROOT, runCorpus } from './run.js';

const GENERATOR = fileURLToPath(new URL('./generate.php', import.meta.url));

const USAGE = `用法：node evaluation/real-repo/cli.js <command> [options]

  evaluate  --repo label=path... [--seed 42] [--rate 0.3] [--out real-repo-eval-output]
            [--baseline-ref <git ref>] [--concurrency N] [--timeout-ms 30000]
            產生 corpus、執行 pipeline、輸出報表；指定 --baseline-ref 時同時與該版本比較。
  generate  --repo label=path... --out corpus.jsonl [--seed 42] [--rate 0.3]
  run       --corpus corpus.jsonl --repo label=path... --out results.jsonl
            [--baseline-ref <git ref> | --reviewer <dir>] [--concurrency N] [--timeout-ms 30000]
  report    --results results.jsonl [--json]
  compare   --baseline-results baseline.jsonl --candidate-results candidate.jsonl [--json]
  inspect   --corpus corpus.jsonl [--repo label=path...] [--results results.jsonl...] <index>...

exit code：0 通過；1 gate failure（evaluate / run / report）；2 參數或執行錯誤。
gate：risky mutation 被判為 NOT_SELECTED、analyzer 錯誤或逾時、未變更且可解析的檔案
沒有被判為 NOT_SELECTED、沒有任何一筆被實際分析。compare 只輸出差異，不影響 exit code。`;

const DEFAULT_CONCURRENCY = Math.min(availableParallelism(), 8);

/**
 * 寫一行訊息到 stderr。
 *
 * @param {string} message - 訊息。
 * @returns {void}
 */
function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * 解析數值參數。
 *
 * @param {string|undefined} value - CLI 值。
 * @param {number} fallback - 預設值。
 * @param {string} name - 參數名稱。
 * @param {{integer?: boolean, min?: number, max?: number}} limits - 合法範圍。
 * @returns {number} 數值。
 */
function numberOption(value, fallback, name, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new Error(`OPTION_INVALID:--${name} ${value}`);
  }
  return parsed;
}

/**
 * 解析 pipeline 執行相關參數。
 *
 * @param {object} values - parseArgs values。
 * @returns {{concurrency: number, timeoutMs: number}} 執行參數。
 */
function executionOptions(values) {
  return {
    concurrency: numberOption(values.concurrency, DEFAULT_CONCURRENCY, 'concurrency', { integer: true, min: 1 }),
    timeoutMs: numberOption(values['timeout-ms'], 30_000, 'timeout-ms', { integer: true, min: 1 }),
  };
}

/**
 * 讀取 JSONL 檔案。
 *
 * @param {string} path - 檔案路徑。
 * @returns {Promise<object[]>} rows。
 */
async function readJsonl(path) {
  return parseJsonl(await readFile(path, 'utf8'));
}

/**
 * 寫入 JSONL 檔案。
 *
 * @param {string} path - 檔案路徑。
 * @param {object[]} rows - rows。
 * @returns {Promise<void>}
 */
async function writeJsonl(path, rows) {
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

/**
 * 以 PHP generator 為每個 repo 產生 mutation，依序寫入同一份 corpus。
 *
 * @param {{repos: Map<string, string>, seed: number, rate: number, out: string}} options - 產生選項。
 * @returns {Promise<void>}
 */
async function generateCorpus({ repos, seed, rate, out }) {
  const handle = await open(out, 'w');
  try {
    for (const [label, path] of repos) {
      const child = spawn('php', [
        '-d', 'memory_limit=2G',
        GENERATOR,
        '--root', path,
        '--label', label,
        '--seed', String(seed),
        '--rate', String(rate),
      ], { stdio: ['ignore', handle.fd, 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      if (code !== 0) throw new Error(`GENERATOR_FAILED:${label}:${stderr.trim()}`);
      log(`generate ${stderr.trim()}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 把 git ref 解開成暫存 snapshot 並執行 callback；不論成功或失敗都會移除 snapshot。
 *
 * @param {string} ref - git ref。
 * @param {function(string): Promise<*>} callback - 以 snapshot 目錄執行的工作。
 * @returns {Promise<*>} callback 結果。
 */
async function withSnapshot(ref, callback) {
  const snapshot = await mkdtemp(join(tmpdir(), 'reviewer-baseline-'));
  try {
    const commit = await prepareBaseline({ reviewerRoot: REVIEWER_ROOT, ref, directory: snapshot });
    log(`baseline ${ref} = ${commit.slice(0, 12)}`);
    return await callback(snapshot);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

/**
 * 回傳進度回呼：每 500 筆與結束時寫一行到 stderr。
 *
 * @param {string} name - 執行名稱。
 * @returns {function} (done, total) callback。
 */
function progress(name) {
  const started = Date.now();
  return (done, total) => {
    if (done % 500 === 0 || done === total) {
      log(`${name}: ${done}/${total} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  };
}

/**
 * 以指定 reviewer checkout 執行 corpus 並寫出結果。
 *
 * @param {object} options - 執行選項。
 * @returns {Promise<object[]>} result rows。
 */
async function runAndWrite({ corpus, repos, out, reviewerRoot, concurrency, timeoutMs, name }) {
  const results = await runCorpus(corpus, {
    repos,
    reviewerRoot,
    concurrency,
    timeoutMs,
    onProgress: progress(name),
  });
  await writeJsonl(out, results);
  return results;
}

/**
 * 產生指定 corpus index 的 edits 與各結果，方便追查 gate failure。
 *
 * @param {object} options - inspect 選項。
 * @returns {Promise<string>} 報表文字。
 */
async function inspectRows({ corpus, repos, resultSets, indices }) {
  const lines = [];
  for (const index of indices) {
    const row = corpus[index];
    if (!row) throw new Error(`INDEX_OUT_OF_RANGE:${index}`);
    lines.push(`#${index} ${row.op} (${row.label}) ${row.repo}/${row.path}`);

    const root = repos.get(row.repo);
    const source = root ? await readFile(join(root, row.path)).catch(() => null) : null;
    if (!root) {
      lines.push(`  （未提供 --repo ${row.repo}=<path>，不顯示原始碼）`);
    } else if (!source) {
      lines.push('  SOURCE_MISSING（不顯示原始碼）');
    } else if (sha256(source) !== row.sourceSha256) {
      lines.push('  SOURCE_CHANGED：原始檔在產生 corpus 後已被修改（不顯示原始碼）');
    } else {
      const snippet = (from, to) => JSON.stringify(
        source.subarray(Math.max(0, from), Math.min(source.length, to)).toString('utf8'),
      );
      for (const [start, end, replacement] of row.edits) {
        lines.push(`  @${start}-${end} ${snippet(start - 40, start)} [${snippet(start, end)} -> ${JSON.stringify(replacement)}] ${snippet(end, end + 40)}`);
      }
      if (row.edits.length > 0) lines.push(`  after bytes: ${applyEdits(source, row.edits).length}`);
    }

    for (const [name, results] of resultSets) {
      const result = results.find((candidate) => candidate.index === index);
      if (!result) continue;
      const facts = (result.facts ?? []).map((fact) => (
        `${fact.kind}(${fact.properties?.callee ?? fact.properties?.container ?? fact.properties?.operatorAfter ?? ''})@${fact.start}`
      ));
      lines.push(`  ${name}: ${result.outcome} ${result.decision ?? ''}/${result.fallback ?? '-'} complete=${result.complete} `
        + `${result.reasonCode ?? ''} reasons=${JSON.stringify(result.reasons ?? [])} facts=[${facts.join(', ')}]`
        + (result.error ? ` error=${result.error}` : ''));
    }
  }

  return lines.join('\n');
}

/**
 * 輸出 summary / gate，並在 gate 失敗時設定 exit code 1。
 *
 * @param {object[]} results - result rows。
 * @param {boolean} json - 是否輸出 JSON。
 * @returns {{summary: object, gate: object}} 報表資料。
 */
function report(results, json) {
  const summary = summarizeResults(results);
  const gate = validateResults(results);
  process.stdout.write(json
    ? `${JSON.stringify({ summary, gate }, null, 2)}\n`
    : `${formatSummary(summary, gate)}\n`);
  if (gate.failures.length > 0) process.exitCode = 1;
  return { summary, gate };
}

const EXECUTION_OPTIONS = {
  concurrency: { type: 'string' },
  'timeout-ms': { type: 'string' },
};

const commands = {
  async evaluate(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...EXECUTION_OPTIONS,
        repo: { type: 'string', multiple: true },
        seed: { type: 'string' },
        rate: { type: 'string' },
        out: { type: 'string', default: 'real-repo-eval-output' },
        'baseline-ref': { type: 'string' },
      },
    });
    const repos = parseRepoOptions(values.repo);
    if (repos.size === 0) throw new Error('OPTION_MISSING:--repo');
    const execution = executionOptions(values);
    const seed = numberOption(values.seed, 42, 'seed', { integer: true });
    const rate = numberOption(values.rate, 0.3, 'rate', { min: 0, max: 1 });

    const evaluate = async (baselineRoot) => {
      await mkdir(values.out, { recursive: true });
      const corpusPath = join(values.out, 'corpus.jsonl');
      await generateCorpus({ repos, seed, rate, out: corpusPath });
      const corpus = await readJsonl(corpusPath);
      const candidate = await runAndWrite({
        ...execution, corpus, repos, out: join(values.out, 'candidate.jsonl'), name: 'candidate',
      });

      let comparison = null;
      if (baselineRoot) {
        const baseline = await runAndWrite({
          ...execution,
          corpus,
          repos,
          out: join(values.out, 'baseline.jsonl'),
          reviewerRoot: baselineRoot,
          name: 'baseline',
        });
        comparison = compareResults(baseline, candidate);
        process.stdout.write(`${formatComparison(comparison)}\n\n`);
      }

      const { summary, gate } = report(candidate, false);
      await writeFile(join(values.out, 'report.json'), `${JSON.stringify({ summary, gate, comparison }, null, 2)}\n`);
      const indices = [...new Set(gate.failures.map((failure) => failure.index).filter((index) => index !== null))];
      if (indices.length > 0) {
        process.stdout.write(`\n${await inspectRows({
          corpus, repos, resultSets: [['candidate', candidate]], indices: indices.slice(0, 3),
        })}\n`);
      }
      log(`輸出：${values.out}/`);
    };

    // baseline snapshot 先準備：ref 不存在或依賴安裝失敗時立即結束，不必等 candidate 跑完。
    await (values['baseline-ref'] ? withSnapshot(values['baseline-ref'], evaluate) : evaluate(null));
  },

  async generate(args) {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string', multiple: true },
        seed: { type: 'string' },
        rate: { type: 'string' },
        out: { type: 'string' },
      },
    });
    const repos = parseRepoOptions(values.repo);
    if (repos.size === 0 || !values.out) throw new Error('OPTION_MISSING:--repo / --out');
    await generateCorpus({
      repos,
      seed: numberOption(values.seed, 42, 'seed', { integer: true }),
      rate: numberOption(values.rate, 0.3, 'rate', { min: 0, max: 1 }),
      out: values.out,
    });
  },

  async run(args) {
    const { values } = parseArgs({
      args,
      options: {
        ...EXECUTION_OPTIONS,
        corpus: { type: 'string' },
        repo: { type: 'string', multiple: true },
        out: { type: 'string' },
        'baseline-ref': { type: 'string' },
        reviewer: { type: 'string' },
      },
    });
    if (!values.corpus || !values.out) throw new Error('OPTION_MISSING:--corpus / --out');
    if (values['baseline-ref'] && values.reviewer) {
      throw new Error('OPTION_CONFLICT:--baseline-ref 與 --reviewer 只能擇一');
    }
    const options = {
      ...executionOptions(values),
      corpus: await readJsonl(values.corpus),
      repos: parseRepoOptions(values.repo),
      out: values.out,
    };
    const results = values['baseline-ref']
      ? await withSnapshot(values['baseline-ref'], (root) => runAndWrite({ ...options, reviewerRoot: root, name: 'baseline' }))
      : await runAndWrite({ ...options, reviewerRoot: values.reviewer, name: values.reviewer ?? 'candidate' });
    report(results, false);
  },

  async report(args) {
    const { values } = parseArgs({ args, options: { results: { type: 'string' }, json: { type: 'boolean' } } });
    if (!values.results) throw new Error('OPTION_MISSING:--results');
    report(await readJsonl(values.results), values.json === true);
  },

  async compare(args) {
    const { values } = parseArgs({
      args,
      options: {
        'baseline-results': { type: 'string' },
        'candidate-results': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    if (!values['baseline-results'] || !values['candidate-results']) {
      throw new Error('OPTION_MISSING:--baseline-results / --candidate-results');
    }
    const comparison = compareResults(
      await readJsonl(values['baseline-results']),
      await readJsonl(values['candidate-results']),
    );
    process.stdout.write(values.json
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : `${formatComparison(comparison)}\n`);
  },

  async inspect(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        corpus: { type: 'string' },
        repo: { type: 'string', multiple: true },
        results: { type: 'string', multiple: true },
      },
    });
    if (!values.corpus || positionals.length === 0) throw new Error('OPTION_MISSING:--corpus / <index>');
    const resultSets = [];
    for (const path of values.results ?? []) resultSets.push([path, await readJsonl(path)]);
    process.stdout.write(`${await inspectRows({
      corpus: await readJsonl(values.corpus),
      repos: parseRepoOptions(values.repo),
      resultSets,
      indices: positionals.map((value) => numberOption(value, 0, 'index', { integer: true, min: 0 })),
    })}\n`);
  },
};

const [command, ...args] = process.argv.slice(2);
const wantsHelp = command === undefined || ['help', '-h', '--help'].includes(command)
  || args.includes('-h') || args.includes('--help');
if (wantsHelp) {
  process.stdout.write(`${USAGE}\n`);
} else if (!Object.hasOwn(commands, command)) {
  process.stderr.write(`未知的指令：${command}\n\n${USAGE}\n`);
  process.exitCode = 2;
} else {
  try {
    await commands[command](args);
  } catch (error) {
    log(`error: ${error.message}`);
    process.exitCode = 2;
  }
}
