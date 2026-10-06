import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareBaseline } from '../../evaluation/real-repo/baseline.js';
import { parseJsonl } from '../../evaluation/real-repo/corpus.js';
import { REVIEWER_ROOT, runCorpus } from '../../evaluation/real-repo/run.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../evaluation/real-repo/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../fixtures/php-laravel', import.meta.url));

const workDir = await mkdtemp(join(tmpdir(), 'real-repo-eval-'));
after(() => rm(workDir, { recursive: true, force: true }));

/**
 * 執行 CLI；非 0 exit code 不丟例外，回傳 code 讓測試檢查。
 *
 * @param {string[]} args - CLI 參數。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 執行結果。
 */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: REVIEWER_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('evaluate 在 fixtures 上產生 corpus、執行 pipeline 並通過 gate', async () => {
  const out = join(workDir, 'evaluate');
  const { code, stdout } = await cli(['evaluate', '--repo', `fixtures=${FIXTURES}`, '--rate', '0.25', '--seed', '7', '--out', out]);

  assert.equal(code, 0, stdout);
  assert.match(stdout, /Risky reduced \(must be 0\)\s+0/);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.gate.failures, []);
  assert.ok(report.summary.labels.unchanged.total > 0);
  assert.ok(report.summary.labels.safe.total > 0);
  assert.ok(report.summary.labels.risky.total > 0);
  assert.equal(report.summary.unchangedReductionRate, 1);

  const corpus = parseJsonl(await readFile(join(out, 'corpus.jsonl'), 'utf8'));
  const results = parseJsonl(await readFile(join(out, 'candidate.jsonl'), 'utf8'));
  assert.equal(results.length, corpus.length);
  assert.ok(results.every((row, index) => row.index === index && row.outcome === 'ANALYZED'));
});

test('相同 seed 產生相同 corpus；safe / risky 標籤經過 AST 驗證', async () => {
  const first = join(workDir, 'first.jsonl');
  const second = join(workDir, 'second.jsonl');
  for (const out of [first, second]) {
    const { code, stderr } = await cli(['generate', '--repo', `fixtures=${FIXTURES}`, '--seed', '11', '--rate', '0.5', '--out', out]);
    assert.equal(code, 0, stderr);
  }

  const corpus = await readFile(first, 'utf8');
  assert.equal(corpus, await readFile(second, 'utf8'));
  const rows = parseJsonl(corpus);
  assert.ok(rows.some((row) => row.label === 'safe' && row.op === 'S_RENAME_LOCAL'));
  assert.ok(rows.every((row) => (row.label === 'unchanged') === (row.edits.length === 0)));
});

test('原始檔案在產生 corpus 後被修改時標為 SOURCE_CHANGED 而不分析', async () => {
  const repo = join(workDir, 'repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'Service.php'), "<?php\n\nfunction total($a, $b)\n{\n    return $a < $b;\n}\n");
  const corpusPath = join(workDir, 'stale.jsonl');
  const { code } = await cli(['generate', '--repo', `local=${repo}`, '--rate', '1', '--out', corpusPath]);
  assert.equal(code, 0);
  await writeFile(join(repo, 'Service.php'), "<?php\n\nfunction total($a, $b)\n{\n    return $a > $b;\n}\n");

  const results = await runCorpus(parseJsonl(await readFile(corpusPath, 'utf8')), {
    repos: new Map([['local', repo]]),
    concurrency: 2,
  });
  assert.ok(results.length > 1);
  assert.ok(results.every((row) => row.outcome === 'SOURCE_CHANGED'));
});

test('runCorpus 在缺少 repo root 或 corpus 格式錯誤時拒絕執行', async () => {
  const row = {
    repo: 'local', path: 'a.php', sourceSha256: 'a'.repeat(64), op: 'S_UNCHANGED', label: 'unchanged', edits: [],
  };
  await assert.rejects(runCorpus([row], { repos: new Map() }), /REPO_ROOT_MISSING:local/);
  await assert.rejects(
    runCorpus([{ ...row, label: 'maybe' }], { repos: new Map([['local', workDir]]) }),
    /CORPUS_ROW_INVALID:0:CORPUS_LABEL_INVALID/,
  );
});

test('prepareBaseline 從 git ref 建立可執行的 snapshot', async () => {
  const snapshot = await mkdtemp(join(workDir, 'baseline-'));
  const commit = await prepareBaseline({ reviewerRoot: REVIEWER_ROOT, ref: 'HEAD', directory: snapshot });

  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(existsSync(join(snapshot, 'src/runner.js')));
  assert.ok(existsSync(join(snapshot, 'analyzers/php/vendor/autoload.php')));

  const repo = join(workDir, 'baseline-repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'Service.php'), "<?php\n\nfunction total($a, $b)\n{\n    return $a < $b;\n}\n");
  const corpusPath = join(workDir, 'baseline.jsonl');
  assert.equal((await cli(['generate', '--repo', `local=${repo}`, '--rate', '1', '--out', corpusPath])).code, 0);
  const results = await runCorpus(parseJsonl(await readFile(corpusPath, 'utf8')), {
    repos: new Map([['local', repo]]),
    reviewerRoot: snapshot,
  });
  assert.ok(results.every((row) => row.outcome === 'ANALYZED'));
  await assert.rejects(
    prepareBaseline({ reviewerRoot: REVIEWER_ROOT, ref: 'no-such-ref-xyz', directory: snapshot }),
    /git rev-parse no-such-ref-xyz/,
  );
});

test('report 在 gate failure 時 exit code 為 1；未知指令回傳 2', async () => {
  const results = join(workDir, 'bad-results.jsonl');
  await writeFile(results, `${JSON.stringify({
    index: 0,
    repo: 'local',
    path: 'a.php',
    op: 'R_FLIP_OPERATOR',
    label: 'risky',
    outcome: 'ANALYZED',
    decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
    fallback: null,
    reasons: ['NO_REDUCTION_BLOCKER'],
    facts: [],
  })}\n`);

  const failed = await cli(['report', '--results', results]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /RISKY_REDUCED: 1/);

  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /用法/);

  const missing = await cli(['report']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /OPTION_MISSING:--results/);
});
