import ts from 'typescript';

/**
 * 有語意的註解：型別檢查、lint、bundler / minifier、coverage 與 JSX 編譯指示，以及 triple-slash 指示。
 * 這些註解不能被當成一般註解忽略。ESLint 的 inline 設定（`/* eslint rule: "off" *\/`、`/* global x *\/`、
 * `/* eslint-env *\/`、`/* exported *\/`）只在 block comment 開頭時才是設定，一般文字提到 eslint 不算。
 */
const DIRECTIVE = new RegExp([
  String.raw`@ts-(?:ignore|expect-error|nocheck|check)\b`,
  String.raw`eslint-(?:disable|enable)`,
  String.raw`^/\*\s*(?:eslint(?:-env)?|globals?|exported)(?:\s|\*/)`,
  String.raw`biome-ignore|oxlint-(?:disable|enable)|deno-lint-ignore`,
  String.raw`[@#]__(?:PURE|NO_SIDE_EFFECTS|KEY)__`,
  String.raw`webpack[A-Z]\w*`,
  String.raw`@vite-ignore`,
  String.raw`(?:istanbul|c8|v8)\s+ignore`,
  String.raw`@jsx(?:ImportSource|Frag|Runtime)?\b`,
  String.raw`^///\s*<(?:reference|amd-module|amd-dependency)\b`,
].join('|'));

const JS_FILE = /\.(?:[mc]?js|jsx)$/i;
/** JS 檔中 TypeScript（`checkJs` / `// @ts-check`）會讀取的 JSDoc 型別標籤。TS 檔不使用 JSDoc 型別。 */
const JSDOC_TYPE_TAGS = new Set([
  'type', 'param', 'arg', 'argument', 'returns', 'return', 'typedef', 'template', 'satisfies', 'implements', 'extends',
  'augments', 'enum', 'callback', 'property', 'prop', 'this', 'overload', 'import', 'readonly', 'private', 'protected', 'public',
]);
const NAMED_JSDOC_TAGS = new Set(['param', 'arg', 'argument', 'property', 'prop', 'template', 'typedef', 'callback']);

/**
 * JSDoc 型別運算式的開頭 `{` 對應的結尾位置（引號中的括號不算）；沒有結尾時為最後一個字元。
 *
 * @param {string} text - 以 `{` 開頭的文字。
 * @returns {number} 結尾 `}` 的 index。
 */
function typeEnd(text) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return text.length - 1;
}

/**
 * 正規化 JSDoc 型別運算式：引號外的空白（含多行 JSDoc 每行開頭的 `*`）只在兩個 identifier 之間保留一個，
 * 引號內原樣保留（`{"a  b"}` 與 `{"a b"}` 是不同的字串型別）。
 *
 * @param {string} type - 型別運算式（含大括號）。
 * @returns {string} 正規化後的型別。
 */
function normalizeType(type) {
  let result = '';
  let quote = null;
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index];
    if (quote) {
      result += character;
      if (character === '\\' && index + 1 < type.length) result += type[++index];
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    if (/\s/.test(character)) {
      // 空白與換行後的 `*`（JSDoc 每行開頭）一起略過；只有兩個 identifier 之間（`keyof T`）需要保留一個空白。
      let end = index;
      let newline = false;
      while (end < type.length) {
        if (/\s/.test(type[end])) {
          newline ||= type[end] === '\n';
          end += 1;
        } else if (newline && type[end] === '*' && type[end + 1] !== '/') {
          newline = false;
          end += 1;
        } else {
          break;
        }
      }
      index = end - 1;
      if (/[\w$]$/.test(result) && /^[\w$]/.test(type[end] ?? '')) result += ' ';
      continue;
    }
    result += character;
  }
  return result;
}

/**
 * JSDoc 中帶型別的標籤（`@param {number} x - 說明` → `@param{number} x`）；說明文字不列入，所以只改說明不算變更。
 *
 * @param {string} comment - 原始註解文字（型別中引號內的空白有意義，不能先壓縮）。
 * @returns {string|null} 標籤摘要；不是 JSDoc 或沒有型別標籤時為 null。
 */
export function jsdocTypes(comment) {
  if (!comment.startsWith('/**')) return null;
  const tags = [];
  const pattern = /@([A-Za-z]+)/g;
  for (let match = pattern.exec(comment); match; match = pattern.exec(comment)) {
    if (!JSDOC_TYPE_TAGS.has(match[1])) continue;
    let rest = comment.slice(pattern.lastIndex).trimStart();
    let type = '';
    if (rest.startsWith('{')) {
      const end = typeEnd(rest);
      type = normalizeType(rest.slice(0, end + 1));
      rest = rest.slice(end + 1);
      pattern.lastIndex = comment.length - rest.length;
    }
    let name = '';
    if (match[1] === 'template') {
      // `@template T, U`：所有型別參數都要列入（含 `[T=string]` 這種有預設值的寫法）。
      const parameter = String.raw`(?:\[[^\]]*\]|[\w$]+)`;
      name = ` ${new RegExp(String.raw`^[\s*]*(${parameter}(?:\s*,\s*${parameter})*)`).exec(rest)?.[1].replace(/\s+/g, '') ?? ''}`;
    } else if (NAMED_JSDOC_TAGS.has(match[1])) {
      name = ` ${/^[\s*]*(\[[^\]]*\]|[\w$.]+)/.exec(rest)?.[1] ?? ''}`;
    }
    tags.push(`@${match[1]}${type}${name}`);
  }
  return tags.length > 0 ? tags.join(';') : null;
}

/**
 * 逐一走訪所有 token（含標點）。
 *
 * @param {ts.Node} node - node。
 * @param {ts.SourceFile} sourceFile - source file。
 * @param {function(ts.Node): void} visit - 每個 token 的 callback。
 * @returns {void} 無回傳值。
 */
function forEachToken(node, sourceFile, visit) {
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    visit(node);
    return;
  }
  for (const child of children) forEachToken(child, sourceFile, visit);
}

/**
 * 檔案中的指示註解，依出現順序列出。`key` 為「註解文字@下一個 token 的文字#該文字的第幾個 token」，用來比較兩個版本。
 *
 * 以 parser 產生的 token 取得註解（template、regex、JSX 文字中的 `//` 不會被誤認為註解）。
 * 用「下一個 token」近似註解作用的位置：同一個指示移到另一個 token（包括文字相同的另一個 token）前面時
 * 會被視為不同。前面新增或刪除同樣文字的 token 也會讓編號改變，這時寧可多產生 fact。
 * JS 檔中帶型別標籤的 JSDoc 也列入（key 只含標籤與型別，見 `jsdocTypes()`）。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @returns {Array<{key: string, comment: string, token: string, node: ts.Node, pos: number, end: number}>} 指示註解。
 */
export function directiveComments(sourceFile) {
  const text = sourceFile.text;
  const seen = new Set();
  const directives = [];
  const shebang = ts.getShebang(text);
  if (shebang) directives.push({ key: `${shebang}@<shebang>`, comment: shebang, token: '<shebang>', node: sourceFile, pos: 0, end: shebang.length });
  const occurrences = new Map();
  const javascript = JS_FILE.test(sourceFile.fileName);
  forEachToken(sourceFile, sourceFile, (token) => {
    // JSX 子節點的文字不是 trivia（`<p>// x</p>` 的 `// x` 是要顯示的文字）。
    if (token.kind === ts.SyntaxKind.JsxText) return;
    const tokenText = token.kind === ts.SyntaxKind.EndOfFileToken ? '<eof>' : token.getText(sourceFile);
    // 同樣文字的 token 依出現順序編號：指示從第一個 `foo` 移到第二個 `foo` 前面時 key 會不同。
    const occurrence = occurrences.get(tokenText) ?? 0;
    occurrences.set(tokenText, occurrence + 1);
    // 同一行、前一個 token 之後的註解是 trailing range，換行之後的是 leading range。
    const ranges = [...(ts.getTrailingCommentRanges(text, token.pos) ?? []), ...(ts.getLeadingCommentRanges(text, token.pos) ?? [])];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const raw = text.slice(range.pos, range.end);
      const comment = raw.replace(/\s+/g, ' ').trim();
      const types = javascript ? jsdocTypes(raw) : null;
      if (!DIRECTIVE.test(comment) && types === null) continue;
      const content = DIRECTIVE.test(comment) ? comment : `/** ${types} */`;
      directives.push({ key: `${content}@${tokenText}#${occurrence}`, comment, token: tokenText, node: token, pos: range.pos, end: range.end });
    }
  });
  return directives;
}
