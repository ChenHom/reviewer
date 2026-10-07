const NOT_SELECTED = 'NOT_SELECTED_FOR_HUMAN_REVIEW';

const GENERIC_REASON_PREFIXES = ['COV-', 'COVERAGE_', 'ANALYZER_', 'FACT_UNHANDLED:', 'ELIGIB'];

/**
 * 安全計算比例；沒有分母時回傳 null，避免虛構 100%。
 *
 * @param {number} numerator - 分子。
 * @param {number} denominator - 分母。
 * @returns {number|null} 0..1 比例。
 */
function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 判斷 reason 是否為 domain interpreter 產生的具體原因（而非 generic fallback）。
 *
 * @param {string} reason - decision reason。
 * @returns {boolean} 是否為具體原因。
 */
export function isSpecificReason(reason) {
  return reason !== 'NO_REDUCTION_BLOCKER'
    && !GENERIC_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/**
 * 移除 reason 中隨位置 / subject 變動的 fact id，方便跨版本比較。
 *
 * @param {string} reason - decision reason。
 * @returns {string} normalized reason。
 */
export function normalizeReason(reason) {
  return reason.replace(/php-[0-9a-f]{20}/g, 'php-*');
}

/**
 * 依 op 與 label 彙整 real-repo evaluation 結果。
 *
 * @param {object[]} rows - runner 輸出的結果。
 * @returns {object} deterministic summary。
 */
export function summarizeResults(rows) {
  const ops = {};
  const labels = {};

  for (const row of rows) {
    const op = (ops[row.op] ??= {
      label: row.label, total: 0, reduced: 0, targeted: 0, full: 0, specific: 0, errors: 0, skipped: 0,
    });
    const label = (labels[row.label] ??= { total: 0, analyzed: 0, reduced: 0, targeted: 0, full: 0, specific: 0 });
    op.total += 1;
    label.total += 1;

    if (row.outcome === 'ERROR') {
      op.errors += 1;
      continue;
    }
    if (row.outcome !== 'ANALYZED') {
      op.skipped += 1;
      continue;
    }

    label.analyzed += 1;
    let bucket = 'targeted';
    if (row.decision === NOT_SELECTED) bucket = 'reduced';
    else if (row.fallback === 'FULL') bucket = 'full';
    op[bucket] += 1;
    label[bucket] += 1;
    if ((row.reasons ?? []).some(isSpecificReason)) {
      op.specific += 1;
      label.specific += 1;
    }
  }

  const risky = labels.risky ?? { analyzed: 0, reduced: 0, targeted: 0, specific: 0 };
  const safe = labels.safe ?? { analyzed: 0, reduced: 0 };
  const unchanged = labels.unchanged ?? { analyzed: 0, reduced: 0 };

  return {
    total: rows.length,
    analyzed: rows.filter((row) => row.outcome === 'ANALYZED').length,
    errors: rows.filter((row) => row.outcome === 'ERROR').length,
    skipped: rows.filter((row) => row.outcome !== 'ANALYZED' && row.outcome !== 'ERROR').length,
    labels,
    ops,
    riskyFalseNegatives: risky.reduced,
    riskyTargetedRate: ratio(risky.targeted, risky.analyzed),
    riskySpecificReasonRate: ratio(risky.specific, risky.analyzed),
    safeReductionRate: ratio(safe.reduced, safe.analyzed),
    unchangedReductionRate: ratio(unchanged.reduced, unchanged.analyzed),
  };
}

/**
 * 檢查 evaluation gate：risky 不可被 reduce、analyzer 不可 crash、未變更檔案必須 reduce、
 * 至少要有一筆實際分析。
 *
 * 未變更檔案只有在 corpus 記錄 `parseable: false`（generator 自己無法解析或空檔）時
 * 才允許不被 reduce；不採信受測 analyzer 自己回報的 parse error。
 *
 * @param {object[]} rows - runner 輸出的結果。
 * @returns {{failures: object[], warnings: object[]}} gate failures 與 warnings。
 */
export function validateResults(rows) {
  const failures = [];
  const warnings = [];
  const describe = (code, row) => ({ code, index: row.index, repo: row.repo, path: row.path, op: row.op });

  for (const row of rows) {
    if (row.outcome === 'ERROR') {
      failures.push(describe('ANALYZER_ERROR', row));
    } else if (row.outcome !== 'ANALYZED') {
      warnings.push(describe(row.outcome, row));
    } else if (row.label === 'risky' && row.decision === NOT_SELECTED) {
      failures.push(describe('RISKY_REDUCED', row));
    } else if (row.label === 'unchanged' && row.decision !== NOT_SELECTED && row.parseable !== false) {
      failures.push(describe('UNCHANGED_NOT_REDUCED', row));
    }
  }

  // 全部被略過（--repo 路徑錯誤、corpus 過期）或沒有任何資料時不可視為通過。
  if (!rows.some((row) => row.outcome === 'ANALYZED')) {
    failures.push({ code: 'NO_ROWS_ANALYZED', index: null, repo: null, path: null, op: null });
  }

  return { failures, warnings };
}

/**
 * 產生用於比較的欄位；facts 比較不含 subject（subject 單獨列為一類）。
 *
 * @param {object} row - result row。
 * @returns {object} 各欄位的 comparable 字串。
 */
function comparableFields(row) {
  const facts = (row.facts ?? []).map((fact) => JSON.stringify([
    fact.kind, fact.start, fact.end, fact.properties ?? {},
  ])).sort();
  const subjects = (row.facts ?? []).map((fact) => `${fact.start}:${fact.subject}`).sort();

  return {
    outcome: JSON.stringify([row.outcome, row.error ?? null]),
    decision: String(row.decision ?? null),
    fallback: String(row.fallback ?? null),
    complete: JSON.stringify([row.complete ?? null, row.reasonCode ?? null]),
    reasons: JSON.stringify((row.reasons ?? []).map(normalizeReason).sort()),
    facts: JSON.stringify(facts),
    subjects: JSON.stringify(subjects),
  };
}

/**
 * 比較同一份 corpus 在 baseline 與 candidate 兩個版本的結果。
 *
 * @param {object[]} baselineRows - baseline 結果。
 * @param {object[]} candidateRows - candidate 結果。
 * @param {number} [sampleLimit=5] - 每類保留的範例 index 數。
 * @returns {object} 差異分類、decision 轉換與 reduction 變化。
 */
export function compareResults(baselineRows, candidateRows, sampleLimit = 5) {
  const candidates = new Map(candidateRows.map((row) => [row.index, row]));
  if (candidates.size !== baselineRows.length) {
    throw new Error('COMPARE_CORPUS_MISMATCH:row count');
  }

  const categories = {};
  const transitions = {};
  const newReductions = {};
  const lostReductions = {};
  let identical = 0;

  for (const baseline of baselineRows) {
    const candidate = candidates.get(baseline.index);
    if (!candidate || candidate.path !== baseline.path || candidate.op !== baseline.op) {
      throw new Error(`COMPARE_CORPUS_MISMATCH:index ${baseline.index}`);
    }

    const left = comparableFields(baseline);
    const right = comparableFields(candidate);
    const changed = Object.keys(left).find((field) => left[field] !== right[field]);
    if (changed === undefined) {
      identical += 1;
      continue;
    }

    const key = `${baseline.op}:${changed}`;
    const category = (categories[key] ??= { count: 0, samples: [] });
    category.count += 1;
    if (category.samples.length < sampleLimit) category.samples.push(baseline.index);

    if (left.decision !== right.decision) {
      const transition = `${baseline.label}:${left.decision} -> ${right.decision}`;
      transitions[transition] = (transitions[transition] ?? 0) + 1;
      if (candidate.decision === NOT_SELECTED) {
        newReductions[baseline.label] = (newReductions[baseline.label] ?? 0) + 1;
      } else if (baseline.decision === NOT_SELECTED) {
        lostReductions[baseline.label] = (lostReductions[baseline.label] ?? 0) + 1;
      }
    }
  }

  return { total: baselineRows.length, identical, categories, transitions, newReductions, lostReductions };
}

/**
 * 將比例格式化成百分比。
 *
 * @param {number|null} value - 0..1 ratio。
 * @returns {string} readable percent。
 */
function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * 建立人類可讀的 evaluation 報表。
 *
 * @param {object} summary - summarizeResults() 結果。
 * @param {{failures: object[], warnings: object[]}} gate - validateResults() 結果。
 * @returns {string} multi-line report。
 */
export function formatSummary(summary, gate) {
  const header = ['op', 'label', 'n', 'reduced', 'targeted', 'full', 'specific', 'errors', 'skipped'];
  const widths = [24, 10, 6, 8, 9, 7, 9, 7, 8];
  const line = (cells) => cells.map((cell, index) => (
    index < 2 ? String(cell).padEnd(widths[index]) : String(cell).padStart(widths[index])
  )).join(' ');
  const opRows = Object.entries(summary.ops)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([op, stats]) => line([
      op,
      stats.label,
      stats.total,
      percent(ratio(stats.reduced, stats.total - stats.errors - stats.skipped)),
      percent(ratio(stats.targeted, stats.total - stats.errors - stats.skipped)),
      percent(ratio(stats.full, stats.total - stats.errors - stats.skipped)),
      percent(ratio(stats.specific, stats.total - stats.errors - stats.skipped)),
      stats.errors,
      stats.skipped,
    ]));

  const lines = [
    'Real-repo Evaluation',
    '',
    line(header),
    ...opRows,
    '',
    `Rows                         ${summary.total} (analyzed ${summary.analyzed}, skipped ${summary.skipped}, errors ${summary.errors})`,
    `Risky reduced (must be 0)    ${summary.riskyFalseNegatives}`,
    `Risky targeted rate          ${percent(summary.riskyTargetedRate)}`,
    `Risky specific reason rate   ${percent(summary.riskySpecificReasonRate)}`,
    `Safe reduction rate          ${percent(summary.safeReductionRate)}`,
    `Unchanged reduction rate     ${percent(summary.unchangedReductionRate)}`,
  ];

  if (gate.failures.length > 0) {
    const counts = {};
    for (const failure of gate.failures) counts[failure.code] = (counts[failure.code] ?? 0) + 1;
    lines.push('', 'Gate failures:', ...Object.entries(counts).map(([code, count]) => `- ${code}: ${count}`));
    lines.push(...gate.failures.filter((failure) => failure.index !== null).slice(0, 10).map((failure) => (
      `  #${failure.index} ${failure.code} ${failure.op} ${failure.repo}/${failure.path}`
    )));
  }
  if (gate.warnings.length > 0) {
    const counts = {};
    for (const warning of gate.warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1;
    lines.push('', 'Warnings:', ...Object.entries(counts).map(([code, count]) => `- ${code}: ${count}`));
  }

  return lines.join('\n');
}

/**
 * 建立人類可讀的 baseline / candidate 比較報表。
 *
 * @param {object} comparison - compareResults() 結果。
 * @returns {string} multi-line report。
 */
export function formatComparison(comparison) {
  const lines = [
    'Baseline vs Candidate',
    '',
    `Identical                    ${comparison.identical}/${comparison.total}`,
  ];
  const categories = Object.entries(comparison.categories).sort(([left], [right]) => left.localeCompare(right));
  if (categories.length > 0) {
    lines.push('', 'Changed (op:first differing field):');
    lines.push(...categories.map(([key, { count, samples }]) => `- ${key}: ${count} (e.g. #${samples.join(', #')})`));
  }
  const transitions = Object.entries(comparison.transitions).sort(([left], [right]) => left.localeCompare(right));
  if (transitions.length > 0) {
    lines.push('', 'Decision transitions:', ...transitions.map(([key, count]) => `- ${key}: ${count}`));
  }
  const format = (counts) => Object.entries(counts).map(([label, count]) => `${label} ${count}`).join(', ') || '0';
  lines.push('', `New reductions               ${format(comparison.newReductions)}`);
  lines.push(`Lost reductions              ${format(comparison.lostReductions)}`);

  return lines.join('\n');
}
