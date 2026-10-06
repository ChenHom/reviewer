import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { prepareBaseline } from './baseline.js';
import { applyEdits, parseJsonl, parseRepoOptions } from './corpus.js';
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
            [--baseline <git ref>] [--concurrency N]
            產生 corpus、執行 pipeline、輸出報表；指定 --baseline 時同時與該版本比較。
  generate  --repo label=path... --out corpus.jsonl [--seed 42] [--rate 0.3]
  run       --corpus corpus.jsonl --repo label=path... --out results.jsonl
            [--baseline <git ref> | --reviewer <dir>] [--concurrency N]
  report    --results results.jsonl [--json]
  compare   --baseline baseline.jsonl --candidate candidate.jsonl [--json]
  inspect   --corpus corpus.jsonl --repo label=path... --results results.jsonl... <index>...

gate（任一項不為 0 時 exit code 為 1）：risky mutation 被判為 NOT_SELECTED、
analyzer 錯誤、未變更的檔案沒有被判為 NOT_SELECTED（無法解析或空檔除外）。`;

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
 * 解析正整數 / 比例參數。
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
 * 以目前版本、指定目錄或 git ref snapshot 執行 corpus。
 *
 * @param {object} options - 執行選項。
 * @returns {Promise<object[]>} result rows。
 */
async function runWith({ corpus, repos, out, reviewerRoot, baselineRef, concurrency, name }) {
  let root = reviewerRoot ?? REVIEWER_ROOT;
  let snapshot = null;
  if (baselineRef) {
    snapshot = await mkdtemp(join(tmpdir(), 'reviewer-baseline-'));
    const commit = await prepareBaseline({ reviewerRoot: REVIEWER_ROOT, ref: baselineRef, directory: snapshot });
    log(`${name}: ${baselineRef} (${commit.slice(0, 12)})`);
    root = snapshot;
  }

  try {
    const results = await runCorpus(corpus, { repos, reviewerRoot: root, concurrency, onProgress: progress(name) });
    await writeJsonl(out, results);
    return results;
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
  }
}

/**
 * 印出指定 corpus index 的 edits 與各結果，方便追查 gate failure。
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
    const source = await readFile(join(repos.get(row.repo) ?? '', row.path)).catch(() => null);
    for (const edit of row.edits) {
      if (!source) break;
      const [start, end] = edit;
      const context = (from, to) => JSON.stringify(source.subarray(Math.max(0, from), Math.min(source.length, to)).toString('utf8'));
      lines.push(`  @${start}-${end} ${context(start - 40, start)} [${context(start, end)} -> ${JSON.stringify(edit[2])}] ${context(end, end + 40)}`);
    }
    if (source && row.edits.length > 0) {
      lines.push(`  after bytes: ${applyEdits(source, row.edits).length}`);
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
 * 輸出 summary / gate，並在 gate 失敗時設定 exit code。
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

const commands = {
  async evaluate(args) {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string', multiple: true },
        seed: { type: 'string' },
        rate: { type: 'string' },
        out: { type: 'string', default: 'real-repo-eval-output' },
        baseline: { type: 'string' },
        concurrency: { type: 'string' },
      },
    });
    const repos = parseRepoOptions(values.repo);
    if (repos.size === 0) throw new Error('OPTION_MISSING:--repo');
    const concurrency = numberOption(values.concurrency, Math.min(availableParallelism(), 8), 'concurrency', { integer: true, min: 1 });
    await mkdir(values.out, { recursive: true });

    const corpusPath = join(values.out, 'corpus.jsonl');
    await generateCorpus({
      repos,
      seed: numberOption(values.seed, 42, 'seed', { integer: true }),
      rate: numberOption(values.rate, 0.3, 'rate', { min: 0, max: 1 }),
      out: corpusPath,
    });
    const corpus = await readJsonl(corpusPath);
    const candidate = await runWith({ corpus, repos, out: join(values.out, 'candidate.jsonl'), concurrency, name: 'candidate' });

    let comparison = null;
    if (values.baseline) {
      const baseline = await runWith({
        corpus,
        repos,
        out: join(values.out, 'baseline.jsonl'),
        baselineRef: values.baseline,
        concurrency,
        name: 'baseline',
      });
      comparison = compareResults(baseline, candidate);
      process.stdout.write(`${formatComparison(comparison)}\n\n`);
    }

    const { summary, gate } = report(candidate, false);
    await writeFile(join(values.out, 'report.json'), `${JSON.stringify({ summary, gate, comparison }, null, 2)}\n`);
    if (gate.failures.length > 0) {
      const indices = [...new Set(gate.failures.map((failure) => failure.index))].slice(0, 3);
      process.stdout.write(`\n${await inspectRows({ corpus, repos, resultSets: [['candidate', candidate]], indices })}\n`);
    }
    log(`輸出：${values.out}/`);
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
        corpus: { type: 'string' },
        repo: { type: 'string', multiple: true },
        out: { type: 'string' },
        baseline: { type: 'string' },
        reviewer: { type: 'string' },
        concurrency: { type: 'string' },
      },
    });
    if (!values.corpus || !values.out) throw new Error('OPTION_MISSING:--corpus / --out');
    if (values.baseline && values.reviewer) throw new Error('OPTION_CONFLICT:--baseline 與 --reviewer 只能擇一');
    const results = await runWith({
      corpus: await readJsonl(values.corpus),
      repos: parseRepoOptions(values.repo),
      out: values.out,
      reviewerRoot: values.reviewer,
      baselineRef: values.baseline,
      concurrency: numberOption(values.concurrency, Math.min(availableParallelism(), 8), 'concurrency', { integer: true, min: 1 }),
      name: values.baseline ?? values.reviewer ?? 'candidate',
    });
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
      options: { baseline: { type: 'string' }, candidate: { type: 'string' }, json: { type: 'boolean' } },
    });
    if (!values.baseline || !values.candidate) throw new Error('OPTION_MISSING:--baseline / --candidate');
    const comparison = compareResults(await readJsonl(values.baseline), await readJsonl(values.candidate));
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
if (!Object.hasOwn(commands, command ?? '')) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = command === undefined || command === '--help' ? 0 : 2;
} else {
  try {
    await commands[command](args);
  } catch (error) {
    log(`error: ${error.message}`);
    process.exitCode = 2;
  }
}
