/**
 * 原因代碼的中文說明（文字報表與 AI 審查的輸入共用）。
 */
export const REASON_HINTS = Object.freeze({
  FILE_ADDED: '新增的檔案',
  FILE_DELETED: '刪除的檔案',
  FILE_RENAMED: '檔案改名或搬移（autoload 路徑可能改變）',
  FILE_MODE_CHANGED: '檔案權限改變',
  UNSUPPORTED_FILE_TYPE: '不支援的檔案類型，未分析',
  BINARY_FILE: 'binary 檔案，未分析',
  SYMLINK_CHANGED: 'symlink 變更',
  SUBMODULE_CHANGED: 'submodule 變更',
  'COV-PHP-001:UNRECOGNIZED_PHP_CHANGE': '有無法自動解釋的變更，請看整個檔案',
  'COV-PHP-001:PHP_GRAMMAR_DIVERGENCE': 'PHP 7 與 PHP 8 的解讀不同，請看整個檔案',
  'COV-PHP-001:PHP_PARSE_ERROR': '無法解析，請看整個檔案',
  'COV-PHP-001:PHP_FILE_DELETION_UNSUPPORTED': '檔案被清空',
  'COV-TS-001:UNRECOGNIZED_TS_CHANGE': '有無法自動解釋的變更，請看整個檔案',
  'COV-TS-001:TS_PARSE_ERROR': '無法解析，請看整個檔案',
  'COV-TS-001:TS_FILE_DELETION_UNSUPPORTED': '檔案被清空',
});

/**
 * 原因代碼加上說明（若有），例如 `FILE_ADDED（新增的檔案）`。
 *
 * @param {string} reason - 原因代碼。
 * @returns {string} 顯示文字。
 */
export function reasonWithHint(reason) {
  return REASON_HINTS[reason] ? `${reason}（${REASON_HINTS[reason]}）` : reason;
}
