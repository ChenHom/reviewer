import { createHash } from 'node:crypto';

import ts from 'typescript';

/**
 * TypeScript / JavaScript AST 的 canonical 序列化。
 *
 * 不影響執行語意的差異不進入序列化：排版、註解（有語意的指示註解另外比較，見 directives.js）、
 * 引號種類、分號（ASI 造成的語意差異會反映在 AST 上）、trailing comma、多餘括號（optional
 * chain 外的括號例外，`(a?.b).c` 與 `a?.b.c` 不同）、數字寫法（`1_000`、`0x10`）、property key
 * 是否加引號、多餘的空 statement。型別註記、`as`、`interface` 等型別資訊仍納入比較。
 */

export const FLAG_MASK = [
  ts.NodeFlags.Let,
  ts.NodeFlags.Const,
  ts.NodeFlags.Using,
  ts.NodeFlags.AwaitUsing,
  ts.NodeFlags.Namespace,
  ts.NodeFlags.GlobalAugmentation,
  ts.NodeFlags.OptionalChain,
].reduce((mask, flag) => mask | (flag ?? 0), 0);

/** 帶語意的非 Node 欄位（運算子、keyword、type-only 等）。 */
export const SCALAR_PROPERTIES = ['operator', 'keywordToken', 'token', 'isTypeOnly', 'isTypeOf', 'isExportEquals', 'phaseModifier'];

export const PROPERTY_NAME_PARENTS = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.EnumMember,
]);

const STATEMENT_LIST_PARENTS = new Set([
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.ModuleBlock,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
]);

/**
 * JSX 文字依 JSX 的空白規則正規化（與 Babel 的 cleanJSXElementLiteralChild 相同）：
 * 含換行的空白行被移除，各行頭尾的空白（第一行的開頭、最後一行的結尾除外）被去掉，
 * 非空行之間以一個空白連接。
 *
 * @param {string} text - JsxText 原文。
 * @returns {string} 渲染時的文字。
 */
export function cleanJsxText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });

  let result = '';
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, ' ');
    if (index !== 0) trimmed = trimmed.replace(/^[ ]+/, '');
    if (index !== lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, '');
    if (trimmed) {
      if (index !== lastNonEmpty) trimmed += ' ';
      result += trimmed;
    }
  });
  return result;
}

/**
 * property key 的字串值（`a`、`'a'`、`1`、`'1'` 相同）；不是簡單 key 時回傳 null。
 *
 * @param {ts.Node} name - property name node。
 * @returns {string|null} key。
 */
function propertyKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * 是否為可以省略的空 statement（`a();;`、class body 中多餘的 `;`）。
 *
 * @param {ts.Node} node - node。
 * @returns {boolean} 是否省略。
 */
export function isRedundantEmpty(node) {
  return (node.kind === ts.SyntaxKind.EmptyStatement && STATEMENT_LIST_PARENTS.has(node.parent?.kind))
    || node.kind === ts.SyntaxKind.SemicolonClassElement;
}

/**
 * 建立 canonicalizer。
 *
 * @param {object} [options={}] - 選項。
 * @param {Map<object, string>} [options.names=new Map()] - symbol → canonical 名稱（區域變數改名正規化）。
 * @param {function(ts.Identifier): object|undefined} [options.symbolOf] - identifier 的 symbol。
 * @param {function(ts.ShorthandPropertyAssignment): object|undefined} [options.valueSymbolOf] - 物件簡寫的值 symbol。
 * @returns {{serialize: function(ts.Node): string, hash: function(ts.Node): string, identifier: function(ts.Identifier): string}} canonicalizer。
 */
export function createCanonicalizer({ names = new Map(), symbolOf = () => undefined, valueSymbolOf = () => undefined } = {}) {
  // 結構比對會反覆序列化同一棵子樹，以 node 為 key 快取。
  const cache = new WeakMap();
  // canonical 名稱用 `C:`、原名用 `I:`，兩者不會互相碰撞（原名可能剛好就是 `$0`）。
  const identifier = (node) => {
    const name = names.size > 0 ? names.get(symbolOf(node)) : undefined;
    return name === undefined ? `I:${node.text}` : `C:${name}`;
  };

  /**
   * 序列化一個 node（含子節點）。
   *
   * @param {ts.Node} node - node。
   * @returns {string} 序列化結果；省略的 node 為空字串。
   */
  function serialize(node) {
    let text = cache.get(node);
    if (text === undefined) {
      text = serializeUncached(node);
      cache.set(node, text);
    }
    return text;
  }

  /**
   * serialize 的實作（不經快取）。
   *
   * @param {ts.Node} node - node。
   * @returns {string} 序列化結果。
   */
  function serializeUncached(node) {
    switch (node.kind) {
      case ts.SyntaxKind.ParenthesizedExpression:
        // `(a?.b).c` 與 `a?.b.c` 語意不同：optional chain 外的括號保留。
        return ts.isOptionalChain(node.expression)
          ? `(Paren ${serialize(node.expression)})`
          : serialize(node.expression);
      case ts.SyntaxKind.ParenthesizedType:
        return serialize(node.type);
      case ts.SyntaxKind.Identifier:
        return identifier(node);
      case ts.SyntaxKind.PrivateIdentifier:
        return `P:${node.text}`;
      case ts.SyntaxKind.NumericLiteral:
        // parser 已把 `0x10`、`1_000`、`1e3`、舊式八進位轉成十進位文字。
        return `N:${node.text}`;
      case ts.SyntaxKind.BigIntLiteral:
        return `B:${BigInt(node.text.slice(0, -1).replace(/_/g, ''))}`;
      case ts.SyntaxKind.StringLiteral:
        // 指示（`'use strict'`）必須逐字相同：statement 位置的字串比較引號內的原文（不處理跳脫）。
        return node.parent?.kind === ts.SyntaxKind.ExpressionStatement
          ? `S!${node.getText().slice(1, -1)}`
          : `S:${JSON.stringify(node.text)}`;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        // tagged template 會拿到 raw 字串，所以比較 raw。
        return `T${node.kind}:${JSON.stringify(node.rawText ?? node.text)}`;
      case ts.SyntaxKind.RegularExpressionLiteral:
        return `R:${node.text}`;
      case ts.SyntaxKind.JsxText: {
        const text = cleanJsxText(node.text);
        return text === '' ? '' : `X:${JSON.stringify(text)}`;
      }
      case ts.SyntaxKind.ShorthandPropertyAssignment: {
        // `{ x }` 的 x 同時是 key 與變數：key 用原名，值用 canonical 名稱。
        const value = names.size > 0 ? names.get(valueSymbolOf(node)) : undefined;
        const initializer = node.objectAssignmentInitializer ? ` ${serialize(node.objectAssignmentInitializer)}` : '';
        return `(Shorthand K:${node.name.text} ${value === undefined ? `I:${node.name.text}` : `C:${value}`}${initializer})`;
      }
      case ts.SyntaxKind.BindingElement:
        // `const { a } = o` 的 a 同時是 key 與區域變數。
        if (!node.propertyName && node.parent?.kind === ts.SyntaxKind.ObjectBindingPattern && ts.isIdentifier(node.name)) {
          return generic(node, `K:${node.name.text}`);
        }
        return generic(node);
      default:
        return generic(node);
    }
  }

  /**
   * 一般 node：種類、語意相關的 flag 與欄位，再依序序列化子節點（list 以 `[...]` 標示邊界）。
   *
   * @param {ts.Node} node - node。
   * @param {string} [prefix=''] - 額外的標記。
   * @returns {string} 序列化結果。
   */
  function generic(node, prefix = '') {
    const parts = [ts.SyntaxKind[node.kind]];
    if (prefix) parts.push(prefix);
    const flags = node.flags & FLAG_MASK;
    if (flags) parts.push(`F${flags}`);
    for (const property of SCALAR_PROPERTIES) {
      const value = node[property];
      if (value !== undefined && typeof value !== 'object') parts.push(`${property}=${value}`);
    }
    const child = (item) => {
      if (isRedundantEmpty(item)) return '';
      if (PROPERTY_NAME_PARENTS.has(node.kind) && item === node.name) {
        const key = propertyKey(item);
        if (key !== null) return `K:${JSON.stringify(key)}`;
      }
      return serialize(item);
    };
    ts.forEachChild(
      node,
      (item) => {
        const text = child(item);
        if (text !== '') parts.push(text);
      },
      (items) => {
        parts.push(`[${items.map(child).filter((text) => text !== '').join(' ')}]`);
      },
    );
    return `(${parts.join(' ')})`;
  }

  return {
    serialize,
    hash: (node) => createHash('sha256').update(serialize(node)).digest('hex'),
    identifier,
  };
}
