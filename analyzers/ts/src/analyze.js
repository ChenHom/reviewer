import ts from 'typescript';

import { attachCallContainers, buildCallFacts, extractCalls, factId } from './calls.js';
import { createCanonicalizer } from './canonicalizer.js';
import { directiveComments } from './directives.js';
import { annotateScopes } from './scope-hashes.js';
import { canonicalNames, checkerFor } from './scopes.js';
import { StructuralDiff } from './structural-diff.js';
import { byteOffset, subjectOf } from './syntax.js';

/**
 * TypeScript / JavaScript analyzer。
 *
 * 以 AST 結構比對兩個版本：每個差異都必須由 fact 解釋（與 PHP analyzer 相同的 fact 詞彙，另有 decorator 的
 * `ANNOTATION_*` 與指示註解的 `DIRECTIVE_COMMENT_CHANGED`），否則為 `UNRECOGNIZED_TS_CHANGE`。
 * 沒有任何 fact 且 `COMPLETE` 只會發生在兩個版本的 canonical AST 相同時（排版、註解、引號、分號、多餘括號、
 * property key 引號、數字寫法，或 function 內一致的區域變數改名）。任一側有語法錯誤 → `TS_PARSE_ERROR`。
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
 * 以指定的命名方式分析一次：call facts、結構性 facts 與未解釋差異。
 *
 * @param {object} options - 設定。
 * @param {string} options.path - 檔案路徑。
 * @param {ts.SourceFile} options.before - before。
 * @param {ts.SourceFile} options.after - after。
 * @param {object} options.beforeHasher - before 的 canonicalizer。
 * @param {object} options.afterHasher - after 的 canonicalizer。
 * @param {boolean} [options.explainVariables=false] - 是否以 VARIABLE_CHANGED 描述變數名稱的差異。
 * @returns {{facts: object[], unexplained: Array}} 結果。
 */
function analyzePass({ path, before, after, beforeHasher, afterHasher, explainVariables = false }) {
  const beforeCalls = extractCalls(before, path, beforeHasher.identifier);
  const afterCalls = extractCalls(after, path, afterHasher.identifier);
  const callFacts = buildCallFacts(path, beforeCalls, afterCalls);
  const diff = new StructuralDiff({
    path, beforeHasher, afterHasher, beforeCalls, afterCalls, callFacts, explainVariables,
  }).run(before, after);
  attachCallContainers(callFacts, diff.callContainers);
  return {
    facts: [...callFacts.map(({ budgetKey, ...fact }) => fact), ...diff.facts],
    unexplained: diff.unexplained,
  };
}

/**
 * 指示註解（`@ts-ignore`、`eslint-disable`、`#__PURE__`、shebang 等）的增減。
 *
 * @param {string} path - 檔案路徑。
 * @param {ts.SourceFile} before - before。
 * @param {ts.SourceFile} after - after。
 * @returns {object[]} DIRECTIVE_COMMENT_CHANGED facts。
 */
function directiveFacts(path, before, after) {
  const facts = [];
  const counts = (list) => list.reduce((map, item) => map.set(item.key, (map.get(item.key) ?? 0) + 1), new Map());
  const extra = (list, other, side, sourceFile) => {
    const remaining = counts(other);
    for (const item of list) {
      if ((remaining.get(item.key) ?? 0) > 0) {
        remaining.set(item.key, remaining.get(item.key) - 1);
        continue;
      }
      const subject = item.node === sourceFile ? path : subjectOf(item.node, path);
      const range = { startByte: byteOffset(sourceFile.text, item.pos), endByte: byteOffset(sourceFile.text, item.end) };
      const properties = { comment: item.comment, token: item.token, changeSide: side };
      facts.push({
        id: factId(['DIRECTIVE_COMMENT_CHANGED', path, subject, JSON.stringify(properties), range.startByte, range.endByte]),
        kind: 'DIRECTIVE_COMMENT_CHANGED',
        subject,
        properties,
        provenance: { path, ...range },
      });
    }
  };
  const beforeDirectives = directiveComments(before);
  const afterDirectives = directiveComments(after);
  extra(beforeDirectives, afterDirectives, 'before', before);
  extra(afterDirectives, beforeDirectives, 'after', after);
  return facts;
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

  // 先以原始名稱比較；不完整時再以 scope-aware canonical 名稱比較（區域變數改名）；仍不完整時以原始名稱
  // 把變數差異描述成 VARIABLE_CHANGED。後面的比較只有能完整解釋時才採用，否則維持第一次的結果。
  const raw = { before: createCanonicalizer(), after: createCanonicalizer() };
  let analysis = analyzePass({ path, before, after, beforeHasher: raw.before, afterHasher: raw.after });
  let renaming = null;
  if (analysis.unexplained.length > 0) {
    renaming = { before: renamingCanonicalizer(before), after: renamingCanonicalizer(after) };
    const renamed = analyzePass({ path, before, after, beforeHasher: renaming.before, afterHasher: renaming.after });
    if (renamed.unexplained.length === 0) {
      analysis = renamed;
    } else {
      const variables = analyzePass({ path, before, after, beforeHasher: raw.before, afterHasher: raw.after, explainVariables: true });
      if (variables.unexplained.length === 0) analysis = variables;
    }
  }

  const structural = [...analysis.facts, ...directiveFacts(path, before, after)];
  const facts = annotateScopes(structural, after, structural.length > 0 ? (renaming?.after ?? renamingCanonicalizer(after)) : raw.after)
    .sort((left, right) => left.provenance.startByte - right.provenance.startByte
      || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const complete = analysis.unexplained.length === 0;
  const reasonCode = complete ? null : 'UNRECOGNIZED_TS_CHANGE';
  return {
    ok: true,
    status: complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    complete,
    reasonCode,
    diagnostics: complete ? [] : [reasonCode],
    facts,
    ...versions,
  };
}
