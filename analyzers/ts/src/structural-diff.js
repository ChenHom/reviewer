import ts from 'typescript';

import { FLAG_MASK, PROPERTY_NAME_PARENTS, SCALAR_PROPERTIES, cleanJsxText, isRedundantEmpty } from './canonicalizer.js';
import { factId } from './calls.js';
import {
  byteRange,
  calleeOf,
  childSlots,
  containsCallback,
  decoratorCallee,
  isCall,
  isConstant,
  isLiteral,
  propertyKey,
  receiverOfCall,
  subjectOf,
  textOf,
  unwrapParens,
} from './syntax.js';

/**
 * 以 AST 結構比對 before / after，判定 completeness 並產生結構性 facts（與 PHP analyzer 的 StructuralDiff 相同）。
 *
 * Soundness 規則：每個被「解釋」的差異，都必須消耗一個 call fact（CALL_REMOVED / CALL_ADDED）或產生一個新的
 * fact；其餘差異記為未解釋。因此 `complete && facts.length === 0` 只可能發生在兩棵 canonical AST 相同時。
 * 不是子節點的語意欄位（`let` / `const` 等 flag、運算子、type-only）不同時一律未解釋。
 */

const OBJECT_MEMBER_KINDS = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

const NAMED_DECLARATION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

/**
 * JSX 中渲染後為空的文字與多餘的空 statement 不算差異（與 canonicalizer 相同）。
 *
 * @param {ts.Node[]} items - list items。
 * @returns {ts.Node[]} 有意義的 items。
 */
function significant(items) {
  return [...items].filter((item) => !isRedundantEmpty(item)
    && !(item.kind === ts.SyntaxKind.JsxText && cleanJsxText(item.text) === ''));
}

/**
 * Longest common subsequence，回傳配對 index。前後相同的部分先剝除，避免大型 list 的 O(n*m) 表格。
 *
 * @param {string[]} left - 左側 keys。
 * @param {string[]} right - 右側 keys。
 * @returns {Array<[number, number]>} 配對。
 */
function lcs(left, right) {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const pairs = [];
  for (let index = 0; index < prefix; index += 1) pairs.push([index, index]);
  const middleLeft = left.slice(prefix, left.length - suffix);
  const middleRight = right.slice(prefix, right.length - suffix);
  const rows = middleLeft.length;
  const cols = middleRight.length;
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = middleLeft[i] === middleRight[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (middleLeft[i] === middleRight[j]) {
      pairs.push([prefix + i, prefix + j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  for (let index = 0; index < suffix; index += 1) pairs.push([left.length - suffix + index, right.length - suffix + index]);
  return pairs;
}

/**
 * 結構化 container（與 PHP analyzer 相同的形狀）。
 *
 * @param {string} type - 位置種類。
 * @param {string} [text] - 顯示文字。
 * @param {object} [extra] - 種類專屬欄位。
 * @returns {object} container。
 */
function container(type, text, extra = {}) {
  return { type, ...extra, keys: [], text: text ?? type };
}

/**
 * container 加上一層 key。
 *
 * @param {object} base - container。
 * @param {string} key - key。
 * @returns {object} container。
 */
function withKey(base, key) {
  return { ...base, keys: [...base.keys, key], text: `${base.text}[${key}]` };
}

/**
 * `await f()` 的 `f()`；其他運算式原樣回傳。
 *
 * @param {ts.Node} node - 運算式。
 * @returns {ts.Node} 內層運算式。
 */
function unwrapAwait(node) {
  const inner = unwrapParens(node);
  return ts.isAwaitExpression(inner) ? unwrapParens(inner.expression) : inner;
}

/**
 * Early-exit guard：沒有 else，body 只有一個 throw / return。
 *
 * @param {ts.IfStatement} statement - if statement。
 * @returns {string|null} `return` / `throw`；不是 guard 時為 null。
 */
export function guardExit(statement) {
  if (statement.elseStatement) return null;
  let body = statement.thenStatement;
  if (ts.isBlock(body)) {
    const statements = significant(body.statements);
    if (statements.length !== 1) return null;
    [body] = statements;
  }
  if (ts.isReturnStatement(body)) return 'return';
  if (ts.isThrowStatement(body)) return 'throw';
  return null;
}

/**
 * identifier 是否位於變數的位置（宣告、參數、運算式），而不是 property / type / label 等名稱。
 *
 * @param {ts.Identifier} node - identifier。
 * @returns {boolean} 是否為變數位置。
 */
function isVariablePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.name === node && Boolean(parent.propertyName);
  if (
    ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)
    || ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)
    || ts.isJsxAttribute(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
    || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent) || ts.isShorthandPropertyAssignment(parent)
    || NAMED_DECLARATION_KINDS.has(parent.kind) || PROPERTY_NAME_PARENTS.has(parent.kind)
    || ts.isPropertyAssignment(parent) || ts.isTypeParameterDeclaration(parent)
  ) {
    return false;
  }
  return ts.isExpression(node);
}

/**
 * before / after 的 AST 結構比對。
 */
export class StructuralDiff {
  /**
   * 建立比對器。
   *
   * @param {object} options - 比對設定。
   * @param {string} options.path - 檔案路徑。
   * @param {object} options.beforeHasher - before 的 canonicalizer。
   * @param {object} options.afterHasher - after 的 canonicalizer。
   * @param {Map<ts.Node, object>} options.beforeCalls - before 的 call records。
   * @param {Map<ts.Node, object>} options.afterCalls - after 的 call records。
   * @param {object[]} options.callFacts - call grouping 產生的 facts（提供可消耗的 budget）。
   * @param {boolean} [options.explainVariables=false] - 變數名稱不同時輸出 VARIABLE_CHANGED（只在原始名稱比較時使用）。
   */
  constructor({ path, beforeHasher, afterHasher, beforeCalls, afterCalls, callFacts, explainVariables = false }) {
    this.path = path;
    this.beforeHasher = beforeHasher;
    this.afterHasher = afterHasher;
    this.beforeCalls = beforeCalls;
    this.afterCalls = afterCalls;
    this.explainVariables = explainVariables;
    this.budget = new Map();
    for (const fact of callFacts) this.budget.set(fact.budgetKey, (this.budget.get(fact.budgetKey) ?? 0) + 1);
    this.facts = [];
    this.unexplained = [];
    this.consumed = 0;
  }

  /**
   * 比對兩個 source file。
   *
   * @param {ts.SourceFile} before - before。
   * @param {ts.SourceFile} after - after。
   * @returns {{facts: object[], unexplained: Array<[string, number]>}} 結構性 facts 與未解釋差異。
   */
  run(before, after) {
    this.compareList(before.statements, after.statements, container('file'));
    // Soundness 不變式：AST 不同時，至少要有一個差異被 fact 解釋或被標為未解釋。
    if (
      this.unexplained.length === 0
      && this.facts.length === 0
      && this.consumed === 0
      && this.beforeHasher.serialize(before) !== this.afterHasher.serialize(after)
    ) {
      this.markUnexplained('invariant', null);
    }
    return { facts: this.facts, unexplained: this.unexplained };
  }

  /**
   * 兩個 node 的 canonical 序列化是否相同。
   *
   * @param {ts.Node} before - before node。
   * @param {ts.Node} after - after node。
   * @returns {boolean} 是否相同。
   */
  same(before, after) {
    return this.beforeHasher.serialize(before) === this.afterHasher.serialize(after);
  }

  /**
   * 目前的進度，用來判斷子節點比較是否找到任何差異。
   *
   * @returns {string} 未解釋數、fact 數、消耗數。
   */
  progress() {
    return `${this.unexplained.length}:${this.facts.length}:${this.consumed}`;
  }

  /**
   * 記錄一個未解釋的差異。
   *
   * @param {string} what - 差異種類。
   * @param {ts.Node|null} node - before 側的位置。
   * @returns {void} 無回傳值。
   */
  markUnexplained(what, node) {
    this.unexplained.push([what, node ? node.getStart() : -1]);
  }

  /**
   * 消耗一個 call fact 的 budget。
   *
   * @param {string} kind - `CALL_REMOVED` / `CALL_ADDED`。
   * @param {object|undefined} call - call record。
   * @returns {boolean} 是否消耗成功。
   */
  consume(kind, call) {
    if (!call) return false;
    const key = `${kind}\u001f${call.slot}\u001f${call.key}`;
    if ((this.budget.get(key) ?? 0) < 1) return false;
    this.budget.set(key, this.budget.get(key) - 1);
    this.consumed += 1;
    return true;
  }

  /**
   * 同一位置換成另一個呼叫：同時消耗 before 的 CALL_REMOVED 與 after 的 CALL_ADDED；任一個沒有 budget 時都不消耗。
   *
   * @param {object} beforeCall - before 的 call record。
   * @param {object} afterCall - after 的 call record。
   * @returns {boolean} 是否消耗成功。
   */
  consumeReplacement(beforeCall, afterCall) {
    const removed = `CALL_REMOVED\u001f${beforeCall.slot}\u001f${beforeCall.key}`;
    const added = `CALL_ADDED\u001f${afterCall.slot}\u001f${afterCall.key}`;
    if ((this.budget.get(removed) ?? 0) < 1 || (this.budget.get(added) ?? 0) < 1) return false;
    return this.consume('CALL_REMOVED', beforeCall) && this.consume('CALL_ADDED', afterCall);
  }

  /**
   * 新增 fact（subject 與範圍取自 node 所在的那一側）。
   *
   * @param {string} kind - fact 種類。
   * @param {ts.Node} node - fact 的位置。
   * @param {object} properties - fact properties。
   * @returns {void} 無回傳值。
   */
  addFact(kind, node, properties) {
    const subject = subjectOf(node, this.path);
    const range = byteRange(node);
    this.facts.push({
      id: factId([kind, this.path, subject, JSON.stringify(properties), range.startByte, range.endByte]),
      kind,
      subject,
      properties,
      provenance: { path: this.path, ...range },
    });
  }

  /**
   * 呼叫的結構化 callee（有 call record 時用 record 的，decorator 等沒有 record 的呼叫即時計算）。
   *
   * @param {ts.Node} call - call node（after 側優先）。
   * @param {Map<ts.Node, object>} calls - 該側的 call records。
   * @returns {object} callee。
   */
  calleeFor(call, calls) {
    return calls.get(call)?.callee ?? calleeOf(call).callee;
  }

  /**
   * 比對兩個 node。
   *
   * @param {ts.Node} beforeInput - before。
   * @param {ts.Node} afterInput - after。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compare(beforeInput, afterInput, where) {
    const before = unwrapParens(beforeInput);
    const after = unwrapParens(afterInput);
    if (this.same(before, after)) return;
    if (this.explainChainChange(before, after)) return;

    if (isLiteral(before) && isLiteral(after)) {
      this.addFact('LITERAL_CHANGED', after, { container: where, before: textOf(before), after: textOf(after), changeSide: 'after' });
      return;
    }
    if (before.kind !== after.kind) {
      this.compareDifferentKinds(before, after, where);
      return;
    }

    switch (before.kind) {
      case ts.SyntaxKind.Identifier:
        if (this.explainVariables && isVariablePosition(before) && isVariablePosition(after)) {
          this.addFact('VARIABLE_CHANGED', after, { container: where, before: before.text, after: after.text, changeSide: 'after' });
        } else {
          this.markUnexplained('identifier', before);
        }
        return;
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.NewExpression:
        this.compareCalls(before, after, where);
        return;
      case ts.SyntaxKind.ReturnStatement:
        this.compareReturn(before, after);
        return;
      case ts.SyntaxKind.BinaryExpression:
        if (
          before.operatorToken.kind !== after.operatorToken.kind
          && this.same(before.left, after.left)
          && this.same(before.right, after.right)
        ) {
          this.addFact('BINARY_OPERATOR_CHANGED', after, {
            container: where,
            operatorBefore: ts.tokenToString(before.operatorToken.kind),
            operatorAfter: ts.tokenToString(after.operatorToken.kind),
            before: textOf(before),
            after: textOf(after),
            changeSide: 'after',
          });
          return;
        }
        break;
      case ts.SyntaxKind.ShorthandPropertyAssignment:
        // `{ a }` 的 a 同時是 key：名稱不同代表 key 改變。
        if (before.name.text !== after.name.text) {
          this.markUnexplained('shorthand-key', before);
          return;
        }
        break;
      case ts.SyntaxKind.BindingElement:
        // `const { a } = o` 的 a 同時是取用的 key。
        if (!before.propertyName && !after.propertyName && before.name.getText() !== after.name.getText()) {
          this.markUnexplained('binding-key', before);
          return;
        }
        break;
      default:
        break;
    }
    this.compareChildren(before, after, where);
  }

  /**
   * 一般 node：語意欄位必須相同，子節點依欄位名稱逐一比較。
   *
   * @param {ts.Node} before - before。
   * @param {ts.Node} after - after。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compareChildren(before, after, where) {
    if (
      (before.flags & FLAG_MASK) !== (after.flags & FLAG_MASK)
      || SCALAR_PROPERTIES.some((property) => typeof before[property] !== 'object' && before[property] !== after[property])
    ) {
      this.markUnexplained('scalar', before);
      return;
    }

    const progress = this.progress();
    const beforeSlots = new Map(childSlots(before));
    const afterSlots = new Map(childSlots(after));
    for (const key of new Set([...beforeSlots.keys(), ...afterSlots.keys()])) {
      let left = beforeSlots.get(key);
      let right = afterSlots.get(key);
      // 沒有 NodeArray 與空的 NodeArray 相同（`m()` 沒有 modifiers、`@A() m()` 有）：當成空 list 比較。
      if (left === undefined && Array.isArray(right)) left = [];
      if (right === undefined && Array.isArray(left)) right = [];
      if (left === undefined || right === undefined) {
        this.markUnexplained(`slot:${key}`, before);
        continue;
      }
      // property key 由 canonicalizer 正規化；key 不同時視為未解釋（不以字面值變更解釋）。
      if (PROPERTY_NAME_PARENTS.has(before.kind) && key === 'name' && (propertyKey(left) !== null || propertyKey(right) !== null)) {
        if (propertyKey(left) !== propertyKey(right)) this.markUnexplained('property-key', before);
        continue;
      }
      if (Array.isArray(left)) this.compareList(left, right, this.childContainer(before, key, where));
      else this.compare(left, right, this.childContainer(before, key, where));
    }
    // canonical 序列化不同、但子節點比較沒有找到任何差異：差異來自序列化額外納入的資料，必須視為未解釋。
    if (this.progress() === progress) this.markUnexplained('hash-only', before);
  }

  /**
   * 種類不同的兩個 node：`X` ↔ `!X`，其餘未解釋。
   *
   * @param {ts.Node} before - before。
   * @param {ts.Node} after - after。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compareDifferentKinds(before, after, where) {
    const negation = (node) => ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
    if ((negation(after) && this.same(before, unwrapParens(after.operand))) || (negation(before) && this.same(unwrapParens(before.operand), after))) {
      this.addFact('EXPRESSION_NEGATED', after, { container: where, before: textOf(before), after: textOf(after), changeSide: 'after' });
      return;
    }
    this.markUnexplained('node-kind', before);
  }

  /**
   * 鏈中移除或新增一個呼叫（`q.where().forUpdate().first()` ↔ `q.where().first()`），由 CALL_REMOVED / CALL_ADDED 解釋。
   *
   * @param {ts.Node} before - before。
   * @param {ts.Node} after - after。
   * @returns {boolean} 是否已解釋。
   */
  explainChainChange(before, after) {
    const beforeReceiver = isCall(before) ? receiverOfCall(before) : null;
    if (beforeReceiver && this.same(unwrapParens(beforeReceiver), after) && this.consume('CALL_REMOVED', this.beforeCalls.get(before))) {
      return true;
    }
    const afterReceiver = isCall(after) ? receiverOfCall(after) : null;
    return Boolean(afterReceiver && this.same(before, unwrapParens(afterReceiver)) && this.consume('CALL_ADDED', this.afterCalls.get(after)));
  }

  /**
   * 比較兩個呼叫：callee、type arguments 與參數。
   *
   * @param {ts.CallExpression|ts.NewExpression} before - before。
   * @param {ts.CallExpression|ts.NewExpression} after - after。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compareCalls(before, after, where) {
    const beforeCall = this.beforeCalls.get(before);
    const afterCall = this.afterCalls.get(after);
    const beforeCallee = unwrapParens(before.expression);
    const afterCallee = unwrapParens(after.expression);

    // 同一位置換成另一個呼叫（`jwt.verify(...)` → `jwt.decode(...)`）：由兩邊的 CALL_REMOVED / CALL_ADDED 解釋名稱的差異。
    if (beforeCall && afterCall && beforeCall.key !== afterCall.key && this.consumeReplacement(beforeCall, afterCall)) {
      const memberBase = (node) => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : null);
      const beforeBase = memberBase(beforeCallee);
      const afterBase = memberBase(afterCallee);
      if (beforeBase && afterBase) this.compare(beforeBase, afterBase, where);
      else if ((beforeBase && beforeCall.callee.receiver === null) || (afterBase && afterCall.callee.receiver === null)) {
        this.markUnexplained('callee-shape', before);
      }
    } else {
      this.compare(beforeCallee, afterCallee, where);
    }
    if (Boolean(before.questionDotToken) !== Boolean(after.questionDotToken)) this.markUnexplained('optional-call', before);

    if ((before.typeArguments === undefined) !== (after.typeArguments === undefined)) {
      this.markUnexplained('type-arguments', before);
    } else if (before.typeArguments) {
      this.compareList(before.typeArguments, after.typeArguments, where);
    }

    if ((before.arguments === undefined) !== (after.arguments === undefined)) {
      this.markUnexplained('arguments', before);
      return;
    }
    const beforeArgs = [...(before.arguments ?? [])];
    const afterArgs = [...(after.arguments ?? [])];
    const callee = this.calleeFor(after, this.afterCalls);
    if (beforeArgs.length !== afterArgs.length) {
      if (!this.explainArgumentCountChange(beforeArgs, afterArgs, after, callee)) this.markUnexplained('argument-count', before);
      return;
    }
    if (this.argumentsReordered(beforeArgs, afterArgs)) {
      this.addFact('CALL_ARGUMENTS_REORDERED', after, {
        callee,
        before: beforeArgs.map(textOf).join(', '),
        after: afterArgs.map(textOf).join(', '),
        changeSide: 'after',
      });
      return;
    }
    beforeArgs.forEach((beforeArg, index) => {
      const afterArg = afterArgs[index];
      if (this.same(beforeArg, afterArg)) return;
      const mark = this.unexplained.length;
      this.compare(beforeArg, afterArg, container('argument', `${callee.text}#${index}`, { callee, argument: index }));
      if (this.unexplained.length > mark && !containsCallback(beforeArg) && !containsCallback(afterArg)) {
        // 位置參數無法被更細的 fact 解釋：輸出 fallback fact（不視為已解釋）。
        this.addFact('CALL_ARGUMENT_CHANGED', afterArg, {
          callee,
          argument: index,
          before: textOf(beforeArg),
          after: textOf(afterArg),
          changeSide: 'after',
        });
      }
    });
  }

  /**
   * 參數數量改變：一邊的參數是另一邊的子序列（純新增或純移除），且增減的參數不含 callback 時，
   * 以 CALL_ARGUMENT_REMOVED / CALL_ARGUMENT_ADDED 解釋。增減的參數含 callback（callback 內可能有任意邏輯）時
   * 仍輸出這些 fact，讓規則可以判斷（例如路由移除 inline 的認證 middleware），但不視為已解釋。
   *
   * @param {ts.Node[]} beforeArgs - before 的參數。
   * @param {ts.Node[]} afterArgs - after 的參數。
   * @param {ts.Node} after - after 的呼叫。
   * @param {object} callee - 結構化 callee。
   * @returns {boolean} 是否已解釋。
   */
  explainArgumentCountChange(beforeArgs, afterArgs, after, callee) {
    const pairs = lcs(beforeArgs.map((arg) => this.beforeHasher.serialize(arg)), afterArgs.map((arg) => this.afterHasher.serialize(arg)));
    if (pairs.length !== Math.min(beforeArgs.length, afterArgs.length)) return false;
    const removed = beforeArgs.length > afterArgs.length;
    const matched = new Set(pairs.map((pair) => pair[removed ? 0 : 1]));
    const changed = (removed ? beforeArgs : afterArgs).map((arg, index) => [arg, index]).filter(([, index]) => !matched.has(index));
    for (const [arg, index] of changed) {
      this.addFact(removed ? 'CALL_ARGUMENT_REMOVED' : 'CALL_ARGUMENT_ADDED', arg, {
        callee,
        argument: index,
        value: textOf(arg),
        changeSide: removed ? 'before' : 'after',
      });
    }
    return !changed.some(([arg]) => containsCallback(arg));
  }

  /**
   * 參數只有順序不同：數量相同（至少兩個）、內容的 multiset 相同、順序不同。
   *
   * @param {ts.Node[]} before - before 的參數。
   * @param {ts.Node[]} after - after 的參數。
   * @returns {boolean} 是否只有順序不同。
   */
  argumentsReordered(before, after) {
    if (before.length < 2) return false;
    const left = before.map((arg) => this.beforeHasher.serialize(arg));
    const right = after.map((arg) => this.afterHasher.serialize(arg));
    return left.join('\u0000') !== right.join('\u0000') && [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
  }

  /**
   * `return` 的值改變：先以更細的 fact 解釋；仍有未解釋差異、且其中一邊是常數時，以 RETURN_VALUE_CHANGED 解釋。
   *
   * @param {ts.ReturnStatement} before - before。
   * @param {ts.ReturnStatement} after - after。
   * @returns {void} 無回傳值。
   */
  compareReturn(before, after) {
    if (!before.expression || !after.expression) {
      this.addFact('RETURN_VALUE_CHANGED', after.expression ?? after, {
        before: before.expression ? textOf(before.expression) : '',
        after: after.expression ? textOf(after.expression) : '',
        changeSide: 'after',
      });
      return;
    }
    const progress = this.progress();
    const mark = this.unexplained.length;
    this.compare(before.expression, after.expression, container('return'));
    if (this.unexplained.length > mark && (isConstant(before.expression) || isConstant(after.expression))) {
      this.unexplained.splice(mark);
      this.addFact('RETURN_VALUE_CHANGED', after.expression, {
        before: textOf(before.expression),
        after: textOf(after.expression),
        changeSide: 'after',
      });
    }
    if (this.progress() === progress) this.markUnexplained('hash-only', before);
  }

  /**
   * 子節點的 container。
   *
   * @param {ts.Node} node - 父節點。
   * @param {string} key - 欄位名稱。
   * @param {object} where - 目前的 container。
   * @returns {object} container。
   */
  childContainer(node, key, where) {
    const name = (target) => (target && ts.isIdentifier(target) ? target.text : propertyKey(target));
    if (ts.isPropertyDeclaration(node) && key === 'initializer' && name(node.name) !== null) {
      return container('property', `property:${name(node.name)}`, { name: name(node.name) });
    }
    if (ts.isVariableDeclaration(node) && key === 'initializer' && ts.isIdentifier(node.name)) {
      const constant = Boolean(node.parent && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const));
      return constant
        ? container('const', `const:${node.name.text}`, { name: node.name.text })
        : container('assign', `assign:${node.name.text}`, { name: node.name.text });
    }
    if (ts.isPropertyAssignment(node) && key === 'initializer' && propertyKey(node.name) !== null) return withKey(where, propertyKey(node.name));
    if (ts.isIfStatement(node) && key === 'expression') return container('if');
    if ((ts.isWhileStatement(node) || ts.isDoStatement(node)) && key === 'expression') return container('while');
    if (ts.isForStatement(node) && key === 'condition') return container('for');
    if (ts.isConditionalExpression(node) && key === 'condition') return container('ternary');
    if (ts.isSwitchStatement(node) && key === 'expression') return container('match');
    if (ts.isCaseClause(node) && key === 'expression') return container('match-arm');
    if (ts.isParameter(node) && key === 'name') return container('param');
    return where;
  }

  /**
   * 比對 list（statement、陣列元素、物件屬性、modifier / decorator 等）：以 LCS 配對相同的項目，再處理差異。
   *
   * @param {ts.Node[]} beforeItems - before。
   * @param {ts.Node[]} afterItems - after。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compareList(beforeItems, afterItems, where) {
    const before = significant(beforeItems);
    const after = significant(afterItems);
    const pairs = lcs(before.map((item) => this.beforeHasher.serialize(item)), after.map((item) => this.afterHasher.serialize(item)));
    pairs.push([before.length, after.length]);
    let beforeIndex = 0;
    let afterIndex = 0;
    for (const [anchorBefore, anchorAfter] of pairs) {
      this.compareGap(before.slice(beforeIndex, anchorBefore), after.slice(afterIndex, anchorAfter), where);
      beforeIndex = anchorBefore + 1;
      afterIndex = anchorAfter + 1;
    }
  }

  /**
   * LCS 之間的差異：可配對的項目直接比較，其餘以 list 的增減解釋。
   *
   * @param {ts.Node[]} removed - before 多出來的項目。
   * @param {ts.Node[]} added - after 多出來的項目。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  compareGap(removed, added, where) {
    if (
      removed.length === 1 && added.length === 1
      && ts.isExpression(removed[0]) && ts.isExpression(added[0])
      && !this.pairable(removed[0], added[0])
    ) {
      this.compare(removed[0], added[0], where);
      return;
    }
    const used = new Set();
    const unpaired = [];
    for (const item of removed) {
      const match = added.findIndex((candidate, index) => !used.has(index) && this.pairable(item, candidate));
      if (match === -1) {
        unpaired.push(item);
        continue;
      }
      used.add(match);
      this.compare(item, added[match], where);
    }
    for (const item of unpaired) this.explainListChange(item, 'before', where);
    added.forEach((item, index) => {
      if (!used.has(index)) this.explainListChange(item, 'after', where);
    });
  }

  /**
   * 兩個 list 項目是否應該互相比較。
   *
   * @param {ts.Node} beforeInput - before。
   * @param {ts.Node} afterInput - after。
   * @returns {boolean} 是否配對。
   */
  pairable(beforeInput, afterInput) {
    const before = unwrapParens(beforeInput);
    const after = unwrapParens(afterInput);
    if (before.kind !== after.kind) return false;
    if (OBJECT_MEMBER_KINDS.has(before.kind) || PROPERTY_NAME_PARENTS.has(before.kind)) {
      if (!before.name || !after.name) return !before.name && !after.name;
      return (propertyKey(before.name) ?? textOf(before.name)) === (propertyKey(after.name) ?? textOf(after.name));
    }
    if (ts.isDecorator(before)) return decoratorCallee(before).name === decoratorCallee(after).name;
    if (ts.isExpressionStatement(before)) {
      const beforeCall = this.beforeCalls.get(unwrapAwait(before.expression));
      const afterCall = this.afterCalls.get(unwrapAwait(after.expression));
      return !beforeCall || !afterCall || beforeCall.key === afterCall.key;
    }
    if (NAMED_DECLARATION_KINDS.has(before.kind)) return before.name?.getText() === after.name?.getText();
    return true;
  }

  /**
   * list 中被移除或新增的項目。
   *
   * @param {ts.Node} item - 項目。
   * @param {'before'|'after'} side - 所在的一側。
   * @param {object} where - container。
   * @returns {void} 無回傳值。
   */
  explainListChange(item, side, where) {
    const removed = side === 'before';
    const calls = removed ? this.beforeCalls : this.afterCalls;

    if (ts.isExpressionStatement(item)) {
      const call = calls.get(unwrapAwait(item.expression));
      if (call && !call.hasCallback && this.consume(removed ? 'CALL_REMOVED' : 'CALL_ADDED', call)) return;
    }
    if (ts.isIfStatement(item)) {
      const exit = guardExit(item);
      if (exit !== null) {
        this.addFact(removed ? 'GUARD_REMOVED' : 'GUARD_ADDED', item, { condition: textOf(item.expression), exit, changeSide: side });
        return;
      }
    }
    if (ts.isDecorator(item)) {
      this.addFact(removed ? 'ANNOTATION_REMOVED' : 'ANNOTATION_ADDED', item, {
        callee: decoratorCallee(item),
        value: textOf(item),
        changeSide: side,
      });
      return;
    }
    const inObject = item.parent && ts.isObjectLiteralExpression(item.parent) && OBJECT_MEMBER_KINDS.has(item.kind);
    const inArray = item.parent && ts.isArrayLiteralExpression(item.parent);
    if (inObject || inArray) {
      let value = textOf(item);
      if (ts.isPropertyAssignment(item)) value = textOf(item.initializer);
      this.addFact(removed ? 'ARRAY_ITEM_REMOVED' : 'ARRAY_ITEM_ADDED', item, {
        container: where,
        key: inObject && item.name ? textOf(item.name) : null,
        value,
        changeSide: side,
      });
      return;
    }
    this.markUnexplained(`list-${side}`, removed ? item : null);
  }
}
