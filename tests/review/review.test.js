import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { formatReview } from '../../src/review/format.js';
import { parseHunks, parseRawDiff, resolveCommit } from '../../src/review/git.js';
import {
  HUMAN_REVIEW,
  NOT_SELECTED,
  changedLines,
  describeFact,
  lineLocator,
  reviewRange,
  summarizeFiles,
} from '../../src/review/review.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../bin/review.js', import.meta.url));
const repo = await mkdtemp(join(tmpdir(), 'review-range-'));
after(() => rm(repo, { recursive: true, force: true }));

const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
const write = async (path, content) => {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), content);
};
const php = (body) => `<?php\n\nclass Service\n{\n    public function run($q)\n    {\n${body}\n    }\n}\n`;

let base;
let head;
let formatOnly;

before(async () => {
  await git('init', '-q');
  await write('src/Format.php', php('        return $q->total(1, 2);'));
  await write('src/Guard.php', php("        $this->authorize('update', $q);\n        return $q->save();"));
  await write('src/Op.php', php('        return $q->amount < 10;'));
  await write('src/Unknown.php', php('        return foo($q);'));
  await write('src/Moved.php', php('        return 1;'));
  await write('src/Exec.php', php('        return 2;'));
  await write('src/Deleted.php', '<?php\n\nfunction legacy_report_export(array $rows): string\n{\n    return implode("\\n", array_map(\'json_encode\', $rows));\n}\n');
  await write('src/Binary.php', Buffer.from('<?php\n\0binary'));
  await write('notes.md', '# notes\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  base = (await git('rev-parse', 'HEAD')).stdout.trim();

  await write('src/Format.php', php('        // reformatted\n        return $q->total(\n            1,\n            2,\n        );'));
  formatOnly = await (async () => {
    await git('commit', '-q', '-am', 'format only');
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  })();

  await write('src/Guard.php', php('        return $q->save();'));
  await write('src/Op.php', php('        return $q->amount <= 10;'));
  await write('src/Unknown.php', php('        return bar($q);'));
  await git('mv', 'src/Moved.php', 'src/Renamed.php');
  await chmod(join(repo, 'src/Exec.php'), 0o755);
  await unlink(join(repo, 'src/Deleted.php'));
  await write('src/Added.php', '<?php\n\nenum Currency: string\n{\n    case Twd = \'TWD\';\n    case Usd = \'USD\';\n}\n');
  await write('src/Binary.php', Buffer.from('<?php\n\0binary changed'));
  await write('notes.md', '# notes\n\nmore\n');
  await symlink('Format.php', join(repo, 'src/Link.php'));
  await git('add', '-A');
  await git('commit', '-q', '-m', 'head');
  head = (await git('rev-parse', 'HEAD')).stdout.trim();
});

test('parseRawDiff 解析修改、新增、刪除、rename、權限與 type change', () => {
  const sha = (n) => String(n).repeat(40);
  const output = [
    `:100644 100644 ${sha(1)} ${sha(2)} M`, 'src/a b.php',
    `:000000 100644 ${sha(0)} ${sha(3)} A`, 'new.php',
    `:100644 000000 ${sha(4)} ${sha(0)} D`, 'gone.php',
    `:100644 100644 ${sha(5)} ${sha(6)} R087`, 'old.php', 'new/place.php',
    `:100644 100755 ${sha(7)} ${sha(7)} M`, 'run.php',
    `:100644 120000 ${sha(8)} ${sha(9)} T`, 'link.php',
    '',
  ].join('\0');
  const entries = parseRawDiff(output);

  assert.deepEqual(entries.map(({ status, oldPath, newPath, similarity }) => [status, oldPath, newPath, similarity]), [
    ['M', 'src/a b.php', 'src/a b.php', null],
    ['A', null, 'new.php', null],
    ['D', 'gone.php', null, null],
    ['R', 'old.php', 'new/place.php', 87],
    ['M', 'run.php', 'run.php', null],
    ['T', 'link.php', 'link.php', null],
  ]);
  assert.equal(entries[4].newMode, '100755');
  assert.deepEqual(parseRawDiff(''), []);
  assert.throws(() => parseRawDiff('garbage\0x\0'), /GIT_DIFF_UNPARSABLE/);
  assert.throws(() => parseRawDiff(`:100644 100644 ${sha(1)} ${sha(2)} R100\0only-old\0`), /GIT_DIFF_UNPARSABLE/);
});

test('parseHunks 與 changedLines 把 hunk 轉成 head / base 行號', () => {
  const hunks = parseHunks('diff --git a/x b/x\n@@ -3 +3 @@\n-a\n+b\n@@ -10,2 +9,0 @@\n@@ -20,0 +18,4 @@ fn\n');
  assert.deepEqual(hunks, [
    { baseStart: 3, baseCount: 1, headStart: 3, headCount: 1 },
    { baseStart: 10, baseCount: 2, headStart: 9, headCount: 0 },
    { baseStart: 20, baseCount: 0, headStart: 18, headCount: 4 },
  ]);
  assert.deepEqual(changedLines(hunks), [
    { side: 'head', startLine: 3, endLine: 3 },
    { side: 'base', startLine: 10, endLine: 11 },
    { side: 'head', startLine: 18, endLine: 21 },
  ]);
});

test('lineLocator 以 UTF-8 byte offset 計算行號', () => {
  const locate = lineLocator('一\n二二\nthree');
  assert.equal(locate(0), 1);
  assert.equal(locate(3), 1);
  assert.equal(locate(4), 2);
  assert.equal(locate(11), 3);
  assert.equal(locate(999), 3);
});

test('describeFact 為每種 fact 產生可讀描述', () => {
  const describe = (kind, properties) => describeFact({ kind, properties });
  assert.equal(describe('CALL_REMOVED', { callee: '$this->authorize' }), '移除呼叫 $this->authorize');
  assert.equal(describe('CALL_ADDED', { callee: 'DB::commit' }), '新增呼叫 DB::commit');
  assert.equal(describe('CALL_ARGUMENT_CHANGED', { callee: '$g->charge', argument: 'key', before: '$a', after: '$b' }), '$g->charge 的參數 key：$a → $b');
  assert.equal(describe('BINARY_OPERATOR_CHANGED', { operatorBefore: '<', operatorAfter: '<=', before: 'a < b', after: 'a <= b' }), '運算子 < → <=：a < b → a <= b');
  assert.equal(describe('GUARD_REMOVED', { condition: '!$ok', exit: 'throw' }), '移除 guard：if (!$ok) throw');
  assert.equal(describe('GUARD_ADDED', { condition: '$x', exit: 'return' }), '新增 guard：if ($x) return');
  assert.equal(describe('ARRAY_ITEM_REMOVED', { container: 'property:$m', key: null, value: "'auth'" }), "property:$m 移除元素 'auth'");
  assert.equal(describe('ARRAY_ITEM_ADDED', { container: 'c', key: "'k'", value: '1' }), "c 新增元素 'k' => 1");
  assert.equal(describe('LITERAL_CHANGED', { container: 'const:RATE', before: '3', after: '30' }), '值 3 → 30（const:RATE）');
  assert.equal(describe('EXPRESSION_NEGATED', { container: 'if', before: '$ok', after: '!$ok' }), '反轉：$ok → !$ok');
  assert.equal(describe('RETURN_VALUE_CHANGED', { before: '$q->total()', after: '' }), '回傳值 $q->total() → （無）');
  assert.equal(describe('RETURN_VALUE_CHANGED', { before: '', after: 'null' }), '回傳值 （無） → null');
  assert.equal(describe('CALL_ARGUMENTS_REORDERED', { callee: 'max', before: '$a, $b', after: '$b, $a' }), 'max 的參數順序：($a, $b) → ($b, $a)');
  assert.equal(describe('VARIABLE_CHANGED', { container: 'param', before: '$amount', after: '$value' }), '參數 $amount → $value');
  assert.equal(describe('VARIABLE_CHANGED', { container: 'return', before: '$a', after: '$b' }), '變數 $a → $b');
  // 多行、過長的片段壓成一行並截斷
  const long = `[\n    'a' => ${'1, '.repeat(40)}\n]`;
  const described = describe('RETURN_VALUE_CHANGED', { before: long, after: 'null' });
  assert.ok(!described.includes('\n'));
  assert.match(described, /^回傳值 \[ 'a' => 1, .{60,}… → null$/u);
  assert.equal(describeFact({ kind: 'SOMETHING_NEW' }), 'SOMETHING_NEW');
});

test('summarizeFiles：所有檔案都不需 review 才是 NOT_SELECTED；空範圍為 NO_CHANGES', () => {
  assert.deepEqual(summarizeFiles([]), {
    status: NOT_SELECTED, reasons: ['NO_CHANGES'], files: 0, notSelected: 0, targeted: 0, full: 0,
  });
  const files = [
    { decision: NOT_SELECTED, fallback: null, reasons: ['NO_REDUCTION_BLOCKER'] },
    { decision: HUMAN_REVIEW, fallback: 'TARGETED', reasons: ['B', 'A'] },
    { decision: HUMAN_REVIEW, fallback: 'FULL', reasons: ['A'] },
  ];
  assert.deepEqual(summarizeFiles(files), {
    status: HUMAN_REVIEW, reasons: ['A', 'B'], files: 3, notSelected: 1, targeted: 1, full: 1,
  });
});

test('reviewRange 逐檔決策並彙整成 PR 層級結果', async () => {
  const report = await reviewRange({ repo, base, head, concurrency: 3 });
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));

  assert.equal(report.base.sha, base);
  assert.equal(report.head.sha, head);
  assert.equal(report.decision.status, HUMAN_REVIEW);

  assert.equal(byPath['src/Format.php'].decision, NOT_SELECTED);
  assert.equal(byPath['src/Format.php'].changedLines, undefined);

  const guard = byPath['src/Guard.php'];
  assert.equal(guard.fallback, 'TARGETED');
  assert.deepEqual(guard.reasons, ['AUTHORIZATION_GUARD_REMOVED']);
  assert.deepEqual(guard.facts.map(({ side, startLine, description }) => [side, startLine, description]), [
    ['base', 7, '移除呼叫 $this->authorize'],
  ]);

  assert.deepEqual(byPath['src/Op.php'].reasons, ['COMPARISON_OPERATOR_CHANGED']);
  assert.equal(byPath['src/Op.php'].facts[0].side, 'head');

  const unknown = byPath['src/Unknown.php'];
  assert.equal(unknown.fallback, 'FULL');
  assert.deepEqual(unknown.changedLines, [{ side: 'head', startLine: 7, endLine: 7 }]);

  const renamed = byPath['src/Renamed.php'];
  assert.equal(renamed.oldPath, 'src/Moved.php');
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.fallback, 'TARGETED');
  assert.deepEqual(renamed.reasons, ['FILE_RENAMED']);

  assert.deepEqual(byPath['src/Exec.php'].reasons, ['FILE_MODE_CHANGED']);
  assert.deepEqual(byPath['src/Deleted.php'].reasons, ['FILE_DELETED']);
  assert.deepEqual(byPath['src/Added.php'].reasons, ['FILE_ADDED']);
  assert.deepEqual(byPath['src/Binary.php'].reasons, ['BINARY_FILE']);
  assert.deepEqual(byPath['notes.md'].reasons, ['UNSUPPORTED_FILE_TYPE']);
  assert.deepEqual(byPath['src/Link.php'].reasons, ['SYMLINK_CHANGED']);

  assert.equal(report.decision.files, report.files.length);
  assert.equal(report.decision.notSelected, 1);

  const text = formatReview(report);
  assert.match(text, /^Review：HUMAN_REVIEW_REQUIRED/);
  assert.match(text, /TARGETED src\/Guard\.php\n\s+- AUTHORIZATION_GUARD_REMOVED\n\s+變更位置：base:L7\n\s+· base:L7 移除呼叫 \$this->authorize/);
  assert.match(text, /src\/Renamed\.php（原 src\/Moved\.php）/);

  const unhandled = formatReview({
    ...report,
    files: [{ path: 'a.php', status: 'modified', decision: HUMAN_REVIEW, fallback: 'TARGETED', reasons: ['FACT_UNHANDLED:php-1', 'FACT_UNHANDLED:php-2'], facts: [] }],
  });
  assert.match(unhandled, /FACT_UNHANDLED ×2/);
  assert.match(text, /不需要 review（1）：\n {2}src\/Format\.php/);
});

test('reviewRange：只有排版變更時 PR 為 NOT_SELECTED；相同 commit 為 NO_CHANGES', async () => {
  const reduced = await reviewRange({ repo, base, head: formatOnly });
  assert.equal(reduced.decision.status, NOT_SELECTED);
  assert.deepEqual(reduced.decision.reasons, []);

  const empty = await reviewRange({ repo, base, head: base });
  assert.deepEqual(empty.decision.reasons, ['NO_CHANGES']);
  assert.match(formatReview(empty), /沒有任何檔案變更/);
});

test('reviewRange：analyzer 失敗時該檔案 fail-closed 為 FULL', async () => {
  const report = await reviewRange({
    repo, base, head: formatOnly, adapterOptions: { phpBinary: join(repo, 'no-such-php') },
  });
  assert.equal(report.decision.status, HUMAN_REVIEW);
  assert.match(report.files[0].reasons[0], /^ANALYZER_ERROR:/);
  assert.equal(report.files[0].fallback, 'FULL');
});

test('reviewRange：從 merge base 算起，base 在分支建立後的新 commit 不列入', async () => {
  const forked = await mkdtemp(join(tmpdir(), 'review-fork-'));
  try {
    const g = (...args) => run('git', ['-C', forked, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
    const put = (path, content) => writeFile(join(forked, path), content);
    await g('init', '-q', '-b', 'main');
    await put('Service.php', php('        return $q->amount < 10;'));
    await put('Other.php', php('        return $q->save();'));
    await g('add', '-A');
    await g('commit', '-q', '-m', 'fork point');
    const forkPoint = (await g('rev-parse', 'HEAD')).stdout.trim();

    await g('checkout', '-q', '-b', 'feature');
    await put('Service.php', php('        return $q->amount <= 10;'));
    await g('commit', '-qam', 'feature change');

    // base 分支在分支建立後繼續前進：只在 base 上的變更不屬於這個 PR。
    await g('checkout', '-q', 'main');
    await put('Other.php', php('        return $q->delete();'));
    await g('commit', '-qam', 'main moves on');
    const mainTip = (await g('rev-parse', 'HEAD')).stdout.trim();

    const report = await reviewRange({ repo: forked, base: 'main', head: 'feature' });
    assert.deepEqual(report.files.map((file) => file.path), ['Service.php']);
    assert.deepEqual(report.files[0].reasons, ['COMPARISON_OPERATOR_CHANGED']);
    assert.equal(report.base.sha, mainTip);
    assert.equal(report.mergeBase, forkPoint);
    assert.match(formatReview(report), new RegExp(`比較起點為 merge base ${forkPoint.slice(0, 12)}`));

    // base 就是 merge base 時不另外標示。
    const direct = await reviewRange({ repo: forked, base: forkPoint, head: 'feature' });
    assert.equal(direct.mergeBase, forkPoint);
    assert.doesNotMatch(formatReview(direct), /merge base/);

    // 沒有共同祖先的 history 無法決定比較起點。
    await g('checkout', '-q', '--orphan', 'unrelated');
    await g('commit', '-q', '-m', 'unrelated', '--allow-empty');
    await assert.rejects(reviewRange({ repo: forked, base: 'main', head: 'unrelated' }), /GIT_NO_MERGE_BASE/);
  } finally {
    await rm(forked, { recursive: true, force: true });
  }
});

test('resolveCommit 拒絕不存在或像選項的 ref', async () => {
  assert.equal(await resolveCommit(repo, base), base);
  await assert.rejects(resolveCommit(repo, 'no-such-ref'), /GIT_FAILED/);
  await assert.rejects(resolveCommit(repo, '--all'), /GIT_REF_INVALID/);
  await assert.rejects(resolveCommit(repo, ''), /GIT_REF_INVALID/);
});

test('bin/review.js：文字、JSON、--out、--fail-on-review 與錯誤處理', async () => {
  const cli = async (args) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };

  const text = await cli(['--repo', repo, '--base', base, '--head', head]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /需要 review：/);

  const out = join(repo, '..', `review-out-${process.pid}`, 'report.json');
  const json = await cli(['--repo', repo, '--base', base, '--head', head, '--json', '--out', out, '--fail-on-review']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).decision.status, HUMAN_REVIEW);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), JSON.parse(json.stdout));
  await rm(join(out, '..'), { recursive: true, force: true });

  assert.equal((await cli(['--repo', repo, '--base', base, '--head', formatOnly, '--fail-on-review'])).code, 0);

  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--fail-on-review/);

  const missing = await cli(['--repo', repo]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /OPTION_MISSING:--base/);

  const badConcurrency = await cli(['--repo', repo, '--base', base, '--concurrency', '0']);
  assert.equal(badConcurrency.code, 2);
  assert.match(badConcurrency.stderr, /OPTION_INVALID:--concurrency/);
});
