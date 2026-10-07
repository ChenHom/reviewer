import { NOT_SELECTED } from './review.js';

const MAX_LISTED = 8;

const REASON_HINTS = Object.freeze({
  FILE_ADDED: '新增的檔案',
  FILE_DELETED: '刪除的檔案',
  FILE_RENAMED: '檔案改名或搬移（autoload 路徑可能改變）',
  FILE_MODE_CHANGED: '檔案權限改變',
  UNSUPPORTED_FILE_TYPE: '非 PHP 檔案，未分析',
  BINARY_FILE: 'binary 檔案，未分析',
  SYMLINK_CHANGED: 'symlink 變更',
  SUBMODULE_CHANGED: 'submodule 變更',
  'COV-PHP-001:UNRECOGNIZED_PHP_CHANGE': '有無法自動解釋的變更，請看整個檔案',
  'COV-PHP-001:PHP_GRAMMAR_DIVERGENCE': 'PHP 7 與 PHP 8 的解讀不同，請看整個檔案',
  'COV-PHP-001:PHP_PARSE_ERROR': '無法解析，請看整個檔案',
  'COV-PHP-001:PHP_FILE_DELETION_UNSUPPORTED': '檔案被清空',
});

/**
 * 原因代碼加上中文提示（若有）。
 *
 * @param {string} reason - 原因代碼。
 * @returns {string} 顯示文字。
 */
function describeReason(reason) {
  if (reason.startsWith('FACT_UNHANDLED:')) return null;
  const hint = REASON_HINTS[reason];
  return hint ? `${reason}（${hint}）` : reason;
}

/**
 * 行號範圍文字，例如 `head:L12` 或 `base:L30-34`。
 *
 * @param {object} fact - file result 中的 fact。
 * @returns {string} 位置。
 */
function location(fact) {
  const lines = fact.startLine === fact.endLine ? `L${fact.startLine}` : `L${fact.startLine}-${fact.endLine}`;
  return `${fact.side}:${lines}`;
}

/**
 * 把 review report 轉成人類可讀的文字。
 *
 * @param {object} report - reviewRange() 結果。
 * @returns {string} multi-line report。
 */
export function formatReview(report) {
  const { decision } = report;
  const needsReview = report.files.filter((file) => file.decision !== NOT_SELECTED);
  const reduced = report.files.filter((file) => file.decision === NOT_SELECTED);
  const lines = [
    `Review：${decision.status}（${needsReview.length}/${decision.files} 個檔案需要 review；TARGETED ${decision.targeted}、FULL ${decision.full}）`,
    `${report.repository}  ${report.base.ref} (${report.base.sha.slice(0, 12)}) → ${report.head.ref} (${report.head.sha.slice(0, 12)})`,
  ];

  if (decision.files === 0) {
    lines.push('', '沒有任何檔案變更。');
    return lines.join('\n');
  }

  if (needsReview.length > 0) {
    lines.push('', '需要 review：');
    const ordered = [...needsReview].sort((left, right) => (
      (left.fallback === 'FULL' ? 0 : 1) - (right.fallback === 'FULL' ? 0 : 1) || left.path.localeCompare(right.path)
    ));
    for (const file of ordered) {
      const rename = file.oldPath ? `（原 ${file.oldPath}）` : '';
      lines.push(`  ${(file.fallback ?? 'FULL').padEnd(8)} ${file.path}${rename}`);
      for (const reason of file.reasons.map(describeReason).filter(Boolean)) {
        lines.push(`           - ${reason}`);
      }
      const unhandled = file.reasons.filter((reason) => reason.startsWith('FACT_UNHANDLED:')).length;
      if (unhandled > 0) {
        lines.push(`           - FACT_UNHANDLED ×${unhandled}（有變更但沒有對應的 domain 規則，請看標示位置）`);
      }
      if (file.changedLines?.length > 0) {
        const ranges = file.changedLines.slice(0, MAX_LISTED).map(location).join('、');
        const more = file.changedLines.length > MAX_LISTED ? ` 等 ${file.changedLines.length} 處` : '';
        lines.push(`           變更位置：${ranges}${more}`);
      }
      for (const fact of file.facts.slice(0, MAX_LISTED)) {
        lines.push(`           · ${location(fact)} ${fact.description}`);
      }
      if (file.facts.length > MAX_LISTED) {
        lines.push(`           · …另有 ${file.facts.length - MAX_LISTED} 項（見 --json）`);
      }
    }
  }

  if (reduced.length > 0) {
    lines.push('', `不需要 review（${reduced.length}）：`);
    lines.push(...reduced.map((file) => `  ${file.path}`));
  }

  return lines.join('\n');
}
