import ts from 'typescript';

import { createCanonicalizer } from './canonicalizer.js';
import { directiveComments } from './directives.js';
import { canonicalNames, checkerFor } from './scopes.js';

/**
 * TypeScript / JavaScript analyzer（第 1 階段：只判斷 AST 是否等價，不輸出 fact）。
 *
 * - 兩個版本的 canonical AST 相同（排版、註解、引號、分號、多餘括號、property key 引號、
 *   數字寫法，或 function 內一致的區域變數改名）→ `COMPLETE`，沒有 fact。
 * - 指示註解（`@ts-ignore`、`eslint-disable`、`#__PURE__` 等）不同 → `DIRECTIVE_COMMENT_CHANGED`。
 * - 其他差異 → `UNRECOGNIZED_TS_CHANGE`。
 * - 任一側有語法錯誤 → `TS_PARSE_ERROR`。
 */

const SCRIPT_KINDS = Object.freeze({
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
});

/**
 * 依副檔名決定 ScriptKind；不支援時為 null。
 *
 * @param {string} path - 檔案路徑。
 * @returns {number|null} ScriptKind。
 */
export function scriptKindFor(path) {
  const match = /\.[^./]+$/.exec(path.toLowerCase());
  return match && Object.hasOwn(SCRIPT_KINDS, match[0]) ? SCRIPT_KINDS[match[0]] : null;
}

/**
 * 解析原始碼；有語法錯誤時回傳 null。
 *
 * @param {string} path - 檔案路徑。
 * @param {string} source - 原始碼。
 * @param {number} scriptKind - ScriptKind。
 * @returns {ts.SourceFile|null} source file。
 */
export function parse(path, source, scriptKind) {
  const sourceFile = ts.createSourceFile(`/${path}`, source, ts.ScriptTarget.Latest, true, scriptKind);
  return sourceFile.parseDiagnostics.length === 0 ? sourceFile : null;
}

/**
 * 以 scope-aware canonical 名稱建立 canonicalizer。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @returns {object} canonicalizer。
 */
export function renamingCanonicalizer(sourceFile) {
  const checker = checkerFor(sourceFile);
  return createCanonicalizer({
    names: canonicalNames(sourceFile, checker),
    symbolOf: (node) => checker.getSymbolAtLocation(node),
    valueSymbolOf: (node) => checker.getShorthandAssignmentValueSymbol(node),
  });
}

/**
 * 分析一組 before / after。
 *
 * @param {{path: string, beforeSource: string, afterSource: string}} input - 輸入。
 * @returns {object} analyzer 結果。
 */
export function analyze({ path, beforeSource, afterSource }) {
  const versions = { tsVersion: ts.version };
  const scriptKind = scriptKindFor(path);
  if (scriptKind === null) return { ok: false, code: 'TS_FILE_TYPE_UNSUPPORTED', ...versions };

  const before = parse(path, beforeSource, scriptKind);
  const after = parse(path, afterSource, scriptKind);
  if (!before || !after) return { ok: false, code: 'TS_PARSE_ERROR', ...versions };

  let reasonCode = null;
  if (JSON.stringify(directiveComments(before)) !== JSON.stringify(directiveComments(after))) {
    reasonCode = 'DIRECTIVE_COMMENT_CHANGED';
  } else {
    const raw = createCanonicalizer();
    const equivalent = raw.hash(before) === raw.hash(after)
      || renamingCanonicalizer(before).hash(before) === renamingCanonicalizer(after).hash(after);
    if (!equivalent) reasonCode = 'UNRECOGNIZED_TS_CHANGE';
  }

  const complete = reasonCode === null;
  return {
    ok: true,
    status: complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    complete,
    reasonCode,
    diagnostics: complete ? [] : [reasonCode],
    facts: [],
    ...versions,
  };
}
