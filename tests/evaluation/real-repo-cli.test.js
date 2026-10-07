import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

import { prepareBaseline } from '../../evaluation/real-repo/baseline.js';
import { parseJsonl, sha256 } from '../../evaluation/real-repo/corpus.js';
import { REVIEWER_ROOT, loadReviewer, runCorpus } from '../../evaluation/real-repo/run.js';

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
    repo: 'local', path: 'a.php', sourceSha256: 'a'.repeat(64), op: 'S_UNCHANGED', label: 'unchanged', parseable: true, edits: [],
  };
  await assert.rejects(runCorpus([row], { repos: new Map() }), /REPO_ROOT_MISSING:local/);
  await assert.rejects(
    runCorpus([row], { repos: new Map([['local', join(workDir, 'no-such-dir')]]) }),
    /REPO_ROOT_NOT_FOUND:local=/,
  );
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

test('analyzer 超過 timeout 時被終止並記為 ERROR（gate failure），不會卡住', async () => {
  // 以 symlink 共用 src/，搭配一個不會結束的 fake analyzer。
  const reviewerRoot = join(workDir, 'slow-reviewer');
  await mkdir(join(reviewerRoot, 'analyzers/php/bin'), { recursive: true });
  await symlink(join(REVIEWER_ROOT, 'src'), join(reviewerRoot, 'src'));
  await writeFile(join(reviewerRoot, 'analyzers/php/bin/analyze.php'), '<?php\nsleep(30);\n');
  const repo = join(workDir, 'slow-repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'a.php'), '<?php\n');
  const row = {
    repo: 'local',
    path: 'a.php',
    sourceSha256: sha256(Buffer.from('<?php\n')),
    op: 'S_UNCHANGED',
    label: 'unchanged',
    parseable: true,
    edits: [],
  };

  const started = Date.now();
  const [result] = await runCorpus([row], { repos: new Map([['local', repo]]), reviewerRoot, timeoutMs: 300 });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(result.outcome, 'ERROR');
  assert.match(result.error, /PHP_ANALYZER_ABORTED/);
});

test('reviewer checkout 缺少 PHP 依賴時立即失敗', async () => {
  const reviewerRoot = join(workDir, 'no-vendor');
  await mkdir(join(reviewerRoot, 'analyzers/php'), { recursive: true });
  await cp(join(REVIEWER_ROOT, 'analyzers/php/composer.json'), join(reviewerRoot, 'analyzers/php/composer.json'));
  await assert.rejects(loadReviewer(reviewerRoot), /ANALYZER_DEPENDENCY_MISSING/);
});

test('generator：每個檔案的 mutation 不受其他檔案影響；__LINE__ 之前的換行只會是 risky', async () => {
  const repo = join(workDir, 'stable-repo');
  await mkdir(repo, { recursive: true });
  const service = "<?php\n\nclass Service\n{\n    public function run($a, $b)\n    {\n        $total = max($a, $b);\n        return [$total < 10, 'ok', $a + $b];\n    }\n}\n";
  await writeFile(join(repo, 'Service.php'), service);
  await writeFile(join(repo, 'Where.php'), "<?php\n\nfunction where()\n{\n    return __LINE__;\n}\n");
  const first = join(workDir, 'stable-1.jsonl');
  assert.equal((await cli(['generate', '--repo', `local=${repo}`, '--rate', '1', '--out', first])).code, 0);

  await writeFile(join(repo, 'Added.php'), "<?php\n\nfunction added($x)\n{\n    return $x * 2;\n}\n");
  const second = join(workDir, 'stable-2.jsonl');
  assert.equal((await cli(['generate', '--repo', `local=${repo}`, '--rate', '1', '--out', second])).code, 0);

  const rowsFor = async (path, file) => parseJsonl(await readFile(path, 'utf8')).filter((row) => row.path === file);
  assert.deepEqual(await rowsFor(second, 'Service.php'), await rowsFor(first, 'Service.php'));
  assert.ok((await rowsFor(first, 'Service.php')).length > 3);

  const where = await rowsFor(first, 'Where.php');
  assert.deepEqual(where.filter((row) => ['S_COMMENT', 'S_WRAP_ARGS'].includes(row.op)), []);
  assert.deepEqual(where.filter((row) => row.label === 'unchanged').map((row) => row.parseable), [true]);

  // 讓 __LINE__ 值改變的換行是 risky，analyzer 不可 reduce。
  const shift = where.filter((row) => row.op === 'R_SHIFT_LINE');
  assert.equal(shift.length, 1);
  const [result] = await runCorpus(shift, { repos: new Map([['local', repo]]) });
  assert.equal(result.outcome, 'ANALYZED');
  assert.equal(result.decision, 'HUMAN_REVIEW_REQUIRED');
});

test('generator：use function 別名的 compact 被視為 name-sensitive，並產生 R_RENAME_COMPACT', async () => {
  const repo = join(workDir, 'compact-repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'Report.php'), "<?php\n\nnamespace App;\n\nuse function compact as pack_vars;\n\nclass Report\n{\n    public function payload($amount)\n    {\n        $total = $amount * 2;\n        $label = 'x';\n        return pack_vars('total');\n    }\n}\n");
  const corpusPath = join(workDir, 'compact.jsonl');
  for (const seed of ['1', '2', '3']) {
    assert.equal((await cli(['generate', '--repo', `local=${repo}`, '--rate', '1', '--seed', seed, '--out', corpusPath])).code, 0);
    const rows = parseJsonl(await readFile(corpusPath, 'utf8'));
    assert.deepEqual(rows.filter((row) => row.op === 'S_RENAME_LOCAL'), [], `seed ${seed}`);
    assert.ok(rows.some((row) => row.op === 'R_RENAME_COMPACT' && row.label === 'risky'), `seed ${seed}`);
  }
});

test('generate 在 git repo 中找不到被追蹤的 PHP 檔時失敗；輸出目錄會自動建立', async () => {
  const repo = join(workDir, 'git-parent');
  await mkdir(join(repo, 'untracked'), { recursive: true });
  await run('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'untracked', 'a.php'), '<?php\n');
  const failed = await cli(['generate', '--repo', `u=${join(repo, 'untracked')}`, '--out', join(workDir, 'u.jsonl')]);
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /no PHP files found/);

  const nested = join(workDir, 'nested', 'deeper', 'corpus.jsonl');
  const ok = await cli(['generate', '--repo', `fixtures=${FIXTURES}`, '--rate', '0', '--out', nested]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(existsSync(nested));
});

test('空字串的 --baseline-ref 與過大的 --timeout-ms 視為參數錯誤', async () => {
  const corpus = join(workDir, 'nested', 'deeper', 'corpus.jsonl');
  const empty = await cli(['run', '--corpus', corpus, '--repo', `fixtures=${FIXTURES}`, '--out', join(workDir, 'x.jsonl'), '--baseline-ref', '']);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /OPTION_INVALID:--baseline-ref/);

  const huge = await cli(['run', '--corpus', corpus, '--repo', `fixtures=${FIXTURES}`, '--out', join(workDir, 'x.jsonl'), '--timeout-ms', '3000000000']);
  assert.equal(huge.code, 2);
  assert.match(huge.stderr, /OPTION_INVALID:--timeout-ms/);
});

test('run --baseline-ref 收到 SIGTERM 時移除 snapshot', async () => {
  const corpusPath = join(workDir, 'sigterm-corpus.jsonl');
  assert.equal((await cli(['generate', '--repo', `fixtures=${FIXTURES}`, '--rate', '1', '--out', corpusPath])).code, 0);
  const tmp = join(workDir, 'sigterm-tmp');
  await mkdir(tmp, { recursive: true });

  const child = spawn(process.execPath, [
    CLI, 'run', '--corpus', corpusPath, '--repo', `fixtures=${FIXTURES}`,
    '--baseline-ref', 'HEAD', '--concurrency', '1', '--out', join(workDir, 'sigterm.jsonl'),
  ], { cwd: REVIEWER_ROOT, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));

  // 等到 snapshot 建好、開始分析後再送 SIGTERM。
  const deadline = Date.now() + 30_000;
  while (!/baseline HEAD =/.test(stderr) && Date.now() < deadline) {
    await setTimeout(50);
  }
  assert.match(stderr, /baseline HEAD =/);
  assert.equal((await readdir(tmp)).filter((name) => name.startsWith('reviewer-baseline-')).length, 1);
  child.kill('SIGTERM');

  const { code } = await exited;
  assert.equal(code, 143);
  assert.deepEqual((await readdir(tmp)).filter((name) => name.startsWith('reviewer-baseline-')), []);
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
  assert.match(unknown.stderr, /未知的指令：frobnicate/);

  for (const args of [[], ['help'], ['--help'], ['evaluate', '--help'], ['run', '-h']]) {
    const help = await cli(args);
    assert.equal(help.code, 0, args.join(' '));
    assert.match(help.stdout, /--baseline-ref/);
  }

  const missing = await cli(['report']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /OPTION_MISSING:--results/);
});
