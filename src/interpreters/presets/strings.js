/**
 * 從 PHP 原始碼片段取出字串 literal 的 helpers（middleware 名稱比對用）。
 */

/**
 * 從 PHP expression 取出所有字串 literal。
 *
 * @param {string} expression - PHP source fragment。
 * @returns {string[]} 字串內容。
 */
export function stringLiterals(expression) {
  return [...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1] ?? match[2]);
}

/**
 * 取出 `'middleware' => ...` 宣告的 middleware 名稱。
 *
 * @param {string} expression - Route::group 第一個參數。
 * @returns {string[]} middleware 名稱。
 */
export function groupMiddlewares(expression) {
  const match = /['"]middleware['"]\s*=>\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(expression);
  return match ? stringLiterals(match[1]) : [];
}

/**
 * before 中有、after 中沒有的字串 literal。
 *
 * @param {unknown} before - 變更前的 PHP 片段。
 * @param {unknown} after - 變更後的 PHP 片段。
 * @returns {string[]} 被移除的字串。
 */
export function removedStrings(before, after) {
  const remaining = new Set(stringLiterals(String(after ?? '')));
  return stringLiterals(String(before ?? '')).filter((name) => !remaining.has(name));
}
