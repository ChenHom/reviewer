import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  applyEdits,
  parseJsonl,
  parseRepoOptions,
  sha256,
  validateCorpusRow,
} from '../../evaluation/real-repo/corpus.js';
import {
  compareResults,
  formatComparison,
  formatSummary,
  isSpecificReason,
  normalizeReason,
  summarizeResults,
  validateResults,
} from '../../evaluation/real-repo/metrics.js';

const HASH = 'a'.repeat(64);

function corpusRow(overrides = {}) {
  return {
    repo: 'shop',
    path: 'app/Service.php',
    sourceSha256: HASH,
    op: 'R_FLIP_OPERATOR',
    label: 'risky',
    edits: [[10, 11, '<=']],
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    index: 0,
    repo: 'shop',
    path: 'app/Service.php',
    op: 'R_FLIP_OPERATOR',
    label: 'risky',
    outcome: 'ANALYZED',
    complete: true,
    status: 'COMPLETE',
    reasonCode: null,
    decision: 'HUMAN_REVIEW_REQUIRED',
    fallback: 'TARGETED',
    reasons: ['COMPARISON_OPERATOR_CHANGED'],
    facts: [{ kind: 'BINARY_OPERATOR_CHANGED', subject: 'Service::run', start: 10, end: 20, properties: {} }],
    ...overrides,
  };
}

test('parseRepoOptions 解析 label=path，拒絕格式錯誤與重複 label', () => {
  assert.deepEqual(
    [...parseRepoOptions(['shop=/repos/shop', 'pay.api=../pay=api'])],
    [['shop', '/repos/shop'], ['pay.api', '../pay=api']],
  );
  assert.deepEqual([...parseRepoOptions()], []);
  for (const invalid of ['shop', '=/repos/shop', 'shop=', 'sh op=/x', 'shop/x=/y']) {
    assert.throws(() => parseRepoOptions([invalid]), /REPO_OPTION_INVALID/, invalid);
  }
  assert.throws(() => parseRepoOptions(['shop=/a', 'shop=/b']), /REPO_LABEL_DUPLICATED:shop/);
});

test('parseJsonl 略過空行並回報錯誤行號', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseJsonl('{"a":1}\nnot json\n'), /JSONL_INVALID:line 2/);
});

test('validateCorpusRow 檢查欄位、edits 格式與 label 一致性', () => {
  assert.deepEqual(validateCorpusRow(corpusRow()), []);
  assert.deepEqual(validateCorpusRow(corpusRow({ op: 'S_UNCHANGED', label: 'unchanged', parseable: true, edits: [] })), []);
  assert.deepEqual(
    validateCorpusRow(corpusRow({ op: 'S_UNCHANGED', label: 'unchanged', edits: [] })),
    ['CORPUS_PARSEABLE_INVALID'],
  );
  assert.deepEqual(validateCorpusRow(null), ['CORPUS_ROW_NOT_OBJECT']);
  assert.deepEqual(validateCorpusRow(corpusRow({ label: 'unknown' })), ['CORPUS_LABEL_INVALID']);
  assert.deepEqual(validateCorpusRow(corpusRow({ sourceSha256: 'abc' })), ['CORPUS_SOURCE_HASH_INVALID']);
  assert.deepEqual(validateCorpusRow(corpusRow({ repo: 'a/b', path: '' })), ['CORPUS_REPO_INVALID', 'CORPUS_PATH_INVALID']);
  for (const edits of [[[5, 4, 'x']], [[-1, 2, 'x']], [[1, 2]], [[1.5, 2, 'x']], 'edits']) {
    assert.deepEqual(validateCorpusRow(corpusRow({ edits })), ['CORPUS_EDITS_INVALID'], JSON.stringify(edits));
  }
  assert.deepEqual(validateCorpusRow(corpusRow({ edits: [] })), ['CORPUS_EDITS_LABEL_MISMATCH']);
  assert.deepEqual(
    validateCorpusRow(corpusRow({ label: 'unchanged', parseable: true, edits: [[0, 0, 'x']] })),
    ['CORPUS_EDITS_LABEL_MISMATCH'],
  );
});

test('applyEdits 以 byte offset 套用多筆 edit（含 UTF-8 多位元組字元與插入）', () => {
  const source = Buffer.from("<?php\n$label = '付款';\nreturn $a < $b;\n", 'utf8');
  const start = source.indexOf('<', 10);
  const quote = source.indexOf("'付款'");

  const after = applyEdits(source, [
    [start, start + 1, '<='],
    [quote, quote + Buffer.byteLength("'付款'"), "'退款'"],
    [0, 0, '// head\n'],
  ]);

  assert.equal(after.toString('utf8'), "// head\n<?php\n$label = '退款';\nreturn $a <= $b;\n");
  assert.equal(applyEdits(source, []).equals(source), true);
});

test('applyEdits 拒絕重疊或超出範圍的 edit', () => {
  const source = Buffer.from('abcdef');
  assert.throws(() => applyEdits(source, [[1, 4, 'x'], [3, 5, 'y']]), /EDIT_RANGE_INVALID/);
  assert.throws(() => applyEdits(source, [[2, 10, 'x']]), /EDIT_RANGE_INVALID/);
  assert.equal(applyEdits(source, [[1, 2, 'X'], [2, 3, 'Y']]).toString(), 'aXYdef');
});

test('sha256 與 Node crypto 相同的 hex digest', () => {
  assert.equal(sha256(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('isSpecificReason 只把 domain blocker 視為具體原因；normalizeReason 去除 fact id', () => {
  assert.equal(isSpecificReason('TRANSACTION_BOUNDARY_REMOVED'), true);
  for (const reason of [
    'NO_REDUCTION_BLOCKER',
    'COV-PHP-001:UNRECOGNIZED_PHP_CHANGE',
    'FACT_UNHANDLED:php-0123456789abcdef0123',
    'ANALYZER_FACT_INTERPRETER_FAILED:x',
    'ELIGIBILITY_MISSING',
  ]) {
    assert.equal(isSpecificReason(reason), false, reason);
  }
  assert.equal(normalizeReason('FACT_UNHANDLED:php-0123456789abcdef0123'), 'FACT_UNHANDLED:php-*');
});

test('validateResults：risky 被 reduce、analyzer 錯誤、未變更檔案未 reduce 都是 gate failure', () => {
  const unchanged = (overrides) => result({ op: 'S_UNCHANGED', label: 'unchanged', parseable: true, ...overrides });
  const { failures, warnings } = validateResults([
    result({ index: 0 }),
    result({ index: 1, decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', fallback: null }),
    result({ index: 2, outcome: 'ERROR', error: 'PHP_ANALYZER_ABORTED' }),
    unchanged({ index: 3, decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW' }),
    // generator 自己也無法解析（或空檔）時才允許不 reduce
    unchanged({ index: 4, parseable: false, reasonCode: 'PHP_PARSE_ERROR', fallback: 'FULL' }),
    unchanged({ index: 5, parseable: false, reasonCode: 'PHP_FILE_DELETION_UNSUPPORTED' }),
    unchanged({ index: 6, reasonCode: 'UNRECOGNIZED_PHP_CHANGE' }),
    // analyzer 宣稱 parse error，但 generator 能解析：analyzer regression
    unchanged({ index: 7, reasonCode: 'PHP_PARSE_ERROR', fallback: 'FULL' }),
    result({ index: 8, op: 'S_COMMENT', label: 'safe' }),
    result({ index: 9, outcome: 'SOURCE_CHANGED' }),
  ]);

  assert.deepEqual(failures.map(({ code, index }) => [code, index]), [
    ['RISKY_REDUCED', 1],
    ['ANALYZER_ERROR', 2],
    ['UNCHANGED_NOT_REDUCED', 6],
    ['UNCHANGED_NOT_REDUCED', 7],
  ]);
  assert.deepEqual(warnings.map(({ code, index }) => [code, index]), [['SOURCE_CHANGED', 9]]);
});

test('validateResults：沒有任何一筆被實際分析時 gate 失敗', () => {
  for (const rows of [[], [result({ outcome: 'SOURCE_MISSING' }), result({ index: 1, outcome: 'SOURCE_CHANGED' })]]) {
    const { failures } = validateResults(rows);
    assert.deepEqual(failures.map(({ code }) => code), ['NO_ROWS_ANALYZED']);
    assert.match(formatSummary(summarizeResults(rows), { failures, warnings: [] }), /- NO_ROWS_ANALYZED: 1/);
  }
});

test('summarizeResults 依 op 與 label 計算 reduced / targeted / full / specific', () => {
  const summary = summarizeResults([
    result({ index: 0 }),
    result({ index: 1, fallback: 'FULL', reasons: ['COV-PHP-001:UNRECOGNIZED_PHP_CHANGE'] }),
    result({ index: 2, op: 'S_COMMENT', label: 'safe', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: ['NO_REDUCTION_BLOCKER'] }),
    result({ index: 3, op: 'S_COMMENT', label: 'safe', fallback: 'FULL', reasons: [] }),
    result({ index: 4, outcome: 'ERROR' }),
    result({ index: 5, outcome: 'SOURCE_MISSING' }),
  ]);

  assert.equal(summary.total, 6);
  assert.equal(summary.analyzed, 4);
  assert.equal(summary.errors, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.ops.R_FLIP_OPERATOR, {
    label: 'risky', total: 4, reduced: 0, targeted: 1, full: 1, specific: 1, errors: 1, skipped: 1,
  });
  assert.equal(summary.riskyFalseNegatives, 0);
  assert.equal(summary.riskyTargetedRate, 0.5);
  assert.equal(summary.riskySpecificReasonRate, 0.5);
  assert.equal(summary.safeReductionRate, 0.5);
  assert.equal(summary.unchangedReductionRate, null);
});

test('formatSummary 列出 gate failures 與 warnings', () => {
  const rows = [
    result({ index: 0, decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW' }),
    result({ index: 1, outcome: 'SOURCE_CHANGED' }),
  ];
  const text = formatSummary(summarizeResults(rows), validateResults(rows));

  assert.match(text, /Risky reduced \(must be 0\)\s+1/);
  assert.match(text, /- RISKY_REDUCED: 1/);
  assert.match(text, /#0 RISKY_REDUCED R_FLIP_OPERATOR shop\/app\/Service.php/);
  assert.match(text, /- SOURCE_CHANGED: 1/);
});

test('compareResults 分類第一個差異欄位並統計 decision 轉換', () => {
  const baseline = [
    result({ index: 0 }),
    result({ index: 1, op: 'S_RENAME_LOCAL', label: 'safe', fallback: 'FULL' }),
    result({ index: 2, op: 'S_COMMENT', label: 'safe', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', fallback: null }),
    result({ index: 3, reasons: ['FACT_UNHANDLED:php-0123456789abcdef0123'] }),
    result({ index: 4 }),
  ];
  const candidate = [
    result({ index: 0 }),
    result({ index: 1, op: 'S_RENAME_LOCAL', label: 'safe', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', fallback: null }),
    result({ index: 2, op: 'S_COMMENT', label: 'safe' }),
    result({ index: 3, reasons: ['FACT_UNHANDLED:php-ffffffffffffffffffff'] }),
    result({ index: 4, facts: [{ kind: 'BINARY_OPERATOR_CHANGED', subject: 'run', start: 10, end: 20, properties: {} }] }),
  ];
  const comparison = compareResults(baseline, candidate);

  assert.equal(comparison.identical, 2);
  assert.deepEqual(comparison.categories, {
    'S_RENAME_LOCAL:decision': { count: 1, samples: [1] },
    'S_COMMENT:decision': { count: 1, samples: [2] },
    'R_FLIP_OPERATOR:subjects': { count: 1, samples: [4] },
  });
  assert.deepEqual(comparison.transitions, {
    'safe:HUMAN_REVIEW_REQUIRED -> NOT_SELECTED_FOR_HUMAN_REVIEW': 1,
    'safe:NOT_SELECTED_FOR_HUMAN_REVIEW -> HUMAN_REVIEW_REQUIRED': 1,
  });
  assert.deepEqual(comparison.newReductions, { safe: 1 });
  assert.deepEqual(comparison.lostReductions, { safe: 1 });
  assert.match(formatComparison(comparison), /Identical\s+2\/5/);
  assert.match(formatComparison(comparison), /New reductions\s+safe 1/);
});

test('compareResults 拒絕不同 corpus 的結果', () => {
  assert.throws(() => compareResults([result()], []), /COMPARE_CORPUS_MISMATCH/);
  assert.throws(
    () => compareResults([result()], [result({ op: 'R_SWAP_ARGS' })]),
    /COMPARE_CORPUS_MISMATCH:index 0/,
  );
});
