/**
 * 專案設定使用的字串與路徑比對器。
 */

/** `/regex/flags` 形式的字串。 */
export const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/s;

/**
 * 字串比對器：`/regex/flags` 為正規表示式，其他字串為完全相等。
 *
 * @param {string} pattern - 比對字串。
 * @returns {function(string): boolean} 比對函式。
 * @throws {SyntaxError} 正規表示式無效時。
 */
export function stringMatcher(pattern) {
  const literal = REGEX_LITERAL.exec(pattern);
  if (!literal) return (value) => value === pattern;
  // `g` / `y` 會讓 test() 帶狀態，比對前移除。
  const regex = new RegExp(literal[1], literal[2].replace(/[gy]/g, ''));
  return (value) => regex.test(value);
}

/**
 * glob（`**`、`*`、`?`）轉成完整比對的正規表示式；路徑以 `/` 分隔。
 *
 * @param {string} glob - glob pattern，例如 `database/migrations/**`。
 * @returns {RegExp} 正規表示式。
 */
export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
