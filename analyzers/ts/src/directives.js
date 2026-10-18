import ts from 'typescript';

/**
 * 有語意的註解：型別檢查、lint、bundler / minifier、coverage 與 JSX 編譯指示，以及 triple-slash 指示。
 * 這些註解不能被當成一般註解忽略。
 */
const DIRECTIVE = new RegExp([
  String.raw`@ts-(?:ignore|expect-error|nocheck|check)\b`,
  String.raw`eslint-(?:disable|enable)`,
  String.raw`[@#]__(?:PURE|NO_SIDE_EFFECTS|KEY)__`,
  String.raw`webpack[A-Z]\w*`,
  String.raw`@vite-ignore`,
  String.raw`(?:istanbul|c8|v8)\s+ignore`,
  String.raw`@jsx(?:ImportSource|Frag|Runtime)?\b`,
  String.raw`^///\s*<(?:reference|amd-module|amd-dependency)\b`,
].join('|'));

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
 * 檔案中的指示註解，依出現順序列出。`key` 為「註解文字@下一個 token」，用來比較兩個版本。
 *
 * 以 parser 產生的 token 取得註解（template、regex、JSX 文字中的 `//` 不會被誤認為註解）。
 * 用「下一個 token 的文字」近似註解作用的位置：同一個指示移到另一個 token 前面時會被視為不同。
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
  forEachToken(sourceFile, sourceFile, (token) => {
    // JSX 子節點的文字不是 trivia（`<p>// x</p>` 的 `// x` 是要顯示的文字）。
    if (token.kind === ts.SyntaxKind.JsxText) return;
    // 同一行、前一個 token 之後的註解是 trailing range，換行之後的是 leading range。
    const ranges = [...(ts.getTrailingCommentRanges(text, token.pos) ?? []), ...(ts.getLeadingCommentRanges(text, token.pos) ?? [])];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = text.slice(range.pos, range.end).replace(/\s+/g, ' ').trim();
      if (!DIRECTIVE.test(comment)) continue;
      const anchor = token.kind === ts.SyntaxKind.EndOfFileToken ? '<eof>' : token.getText(sourceFile);
      directives.push({ key: `${comment}@${anchor}`, comment, token: anchor, node: token, pos: range.pos, end: range.end });
    }
  });
  return directives;
}
