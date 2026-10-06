import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

import { applyEdits, sha256, validateCorpusRow } from './corpus.js';

export const REVIEWER_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 從指定的 reviewer checkout 載入 adapter、interpreters 與 pipeline。
 *
 * 讓同一份 corpus 能在不同版本（例如 git ref 的 snapshot）上執行。
 *
 * @param {string} [reviewerRoot=REVIEWER_ROOT] - reviewer repo 根目錄。
 * @returns {Promise<object>} pipeline 依賴。
 */
export async function loadReviewer(reviewerRoot = REVIEWER_ROOT) {
  const load = (relative) => import(pathToFileURL(join(reviewerRoot, relative)).href);
  const [adapterModule, contracts, domain, publication, runner] = await Promise.all([
    load('src/adapters/php-laravel/adapter.js'),
    load('src/adapters/contracts.js'),
    load('src/interpreters/php-laravel-domain.js'),
    load('src/publication.js'),
    load('src/runner.js'),
  ]);

  return {
    adapter: adapterModule.createPhpLaravelAdapter({
      analyzerPath: join(reviewerRoot, 'analyzers/php/bin/analyze.php'),
    }),
    createAnalysisContextBinding: contracts.createAnalysisContextBinding,
    interpreters: domain.PHP_LARAVEL_DOMAIN_INTERPRETERS,
    createAuthorityState: publication.createAuthorityState,
    runAdapterPipeline: runner.runAdapterPipeline,
  };
}

/**
 * 以完整 pipeline 分析單筆 mutation。
 *
 * @param {object} reviewer - loadReviewer() 結果。
 * @param {object} row - corpus row。
 * @param {number} index - corpus index。
 * @param {string} beforeSource - 原始檔案。
 * @param {string} afterSource - 套用 edits 後的檔案。
 * @param {number} timeoutMs - pipeline timeout。
 * @returns {Promise<object>} result row。
 */
async function analyzeRow(reviewer, row, index, beforeSource, afterSource, timeoutMs) {
  const identity = {
    repository: `real-repo/${row.repo}`,
    baseSha: `base-${index}`,
    headSha: `head-${index}`,
    policyId: 'real-repo-evaluation',
    policyVersion: '1',
    runnerVersion: '1',
  };
  const request = { identity, path: row.path, beforeSource, afterSource };
  const adapterResult = await reviewer.adapter.analyze(request);

  // pipeline 內部會再呼叫一次 adapter；共用同一份結果，避免每筆 mutation 跑兩次 analyzer。
  const replay = {
    descriptor: reviewer.adapter.descriptor,
    analyze: async () => globalThis.structuredClone(adapterResult),
  };
  const state = reviewer.createAuthorityState(
    identity,
    reviewer.createAnalysisContextBinding(adapterResult, reviewer.interpreters),
  );
  const pipeline = await reviewer.runAdapterPipeline(replay, request, state, {
    timeoutMs,
    factInterpreters: reviewer.interpreters,
  });
  const decision = pipeline.candidate?.decision ?? {};

  return {
    outcome: 'ANALYZED',
    complete: adapterResult.complete === true,
    status: adapterResult.obligations?.[0]?.status ?? null,
    reasonCode: adapterResult.reasonCode ?? null,
    decision: decision.status ?? null,
    fallback: decision.fallback ?? null,
    reasons: decision.reasons ?? [],
    facts: (adapterResult.facts ?? []).map((fact) => ({
      kind: fact.kind,
      subject: fact.subject,
      start: fact.provenance?.startByte ?? null,
      end: fact.provenance?.endByte ?? null,
      properties: fact.properties ?? {},
    })),
  };
}

/**
 * 對 corpus 中每筆 mutation 執行完整 pipeline。
 *
 * 原始檔案的 sha256 與 corpus 不符（產生 corpus 後檔案被修改）時，該筆標為
 * `SOURCE_CHANGED` 而不分析，避免 byte offset 套用到錯誤的內容。
 *
 * @param {object[]} corpus - corpus rows（陣列 index 即 corpus index）。
 * @param {object} options - 執行選項。
 * @param {Map<string, string>} options.repos - repo label → path。
 * @param {string} [options.reviewerRoot] - reviewer checkout（預設為本 repo）。
 * @param {number} [options.concurrency=4] - 同時執行的 analyzer 數。
 * @param {number} [options.timeoutMs=30000] - 單筆 pipeline timeout。
 * @param {function} [options.onProgress] - (done, total) 進度回呼。
 * @returns {Promise<object[]>} 依 corpus 順序排列的 result rows。
 */
export async function runCorpus(corpus, {
  repos,
  reviewerRoot = REVIEWER_ROOT,
  concurrency = 4,
  timeoutMs = 30_000,
  onProgress = () => {},
} = {}) {
  corpus.forEach((row, index) => {
    const errors = validateCorpusRow(row);
    if (errors.length > 0) throw new Error(`CORPUS_ROW_INVALID:${index}:${errors.join(',')}`);
    if (!repos?.has(row.repo)) throw new Error(`REPO_ROOT_MISSING:${row.repo}（請用 --repo ${row.repo}=<path> 指定）`);
  });

  const reviewer = await loadReviewer(reviewerRoot);
  const sources = new Map();
  const readSource = (row) => {
    const key = `${row.repo}\0${row.path}`;
    if (!sources.has(key)) {
      sources.set(key, readFile(join(repos.get(row.repo), row.path)).then(
        (bytes) => ({ bytes, hash: sha256(bytes) }),
        () => null,
      ));
    }
    return sources.get(key);
  };

  const results = new Array(corpus.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < corpus.length) {
      const index = next;
      next += 1;
      const row = corpus[index];
      const base = { index, repo: row.repo, path: row.path, op: row.op, label: row.label };
      const source = await readSource(row);

      if (source === null) {
        results[index] = { ...base, outcome: 'SOURCE_MISSING' };
      } else if (source.hash !== row.sourceSha256) {
        results[index] = { ...base, outcome: 'SOURCE_CHANGED' };
      } else {
        try {
          const after = applyEdits(source.bytes, row.edits);
          results[index] = {
            ...base,
            ...await analyzeRow(reviewer, row, index, source.bytes.toString('utf8'), after.toString('utf8'), timeoutMs),
          };
        } catch (error) {
          results[index] = { ...base, outcome: 'ERROR', error: String(error?.message ?? error).slice(0, 500) };
        }
      }

      done += 1;
      onProgress(done, corpus.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return results;
}
