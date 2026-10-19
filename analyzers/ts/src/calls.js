import { createHash } from 'node:crypto';

import ts from 'typescript';

import { byteRange, calleeOf, containsCallback, isAnonymousFunction, isConstant, isNamedFunction, subjectOf, textOf } from './syntax.js';

/**
 * 抽取呼叫，並依 subject + callee 分組配對 before / after，輸出 CALL_REMOVED / CALL_ADDED
 * （與 PHP analyzer 的 CallExtractor / CallFacts 相同）。`new` 與 decorator 的呼叫不在這裡：與 PHP 相同，
 * `new` 只在結構比對中處理；decorator 見 ANNOTATION_* facts。
 */

/**
 * fact id：`ts-` 加 sha256 前 20 碼。
 *
 * @param {Array<string|number>} parts - 組成內容。
 * @returns {string} id。
 */
export function factId(parts) {
  return `ts-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
}

/**
 * 匿名 callback 的錨點文字：傳給哪個呼叫的第幾個參數，以及該呼叫的常數參數
 * （`router.get('/admin', (req, res) => …)` → `I:router.get('/admin',_)#1`）。
 * 不是呼叫參數的匿名 function 以所在位置的 node 種類表示。
 *
 * @param {ts.Node} node - 匿名 function-like。
 * @param {function(ts.Identifier): string} nameOf - identifier 的比對用名稱。
 * @returns {string} 錨點文字。
 */
function callbackAnchor(node, nameOf) {
  const parent = node.parent;
  if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node)) {
    const literals = parent.arguments.map((argument) => (isConstant(argument) ? textOf(argument) : '_')).join(',');
    return `${calleeOf(parent, nameOf).key}(${literals})#${parent.arguments.indexOf(node)}`;
  }
  return ts.SyntaxKind[parent?.kind] ?? 'root';
}

/**
 * 抽取檔案中所有 call record。
 *
 * 同一個 subject 內的呼叫再依所在的匿名 callback 分組（`slot`）：呼叫從一個 callback 移到另一個
 * （例如 `jwt.verify` 從 `/admin` 的 handler 移到 `/public`）時，兩邊的計數會不同，產生 CALL_REMOVED /
 * CALL_ADDED。錨點相同的 callback 依出現順序編號；前面新增錨點不同的 callback（例如另一條路由）不影響編號。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @param {string} path - 檔案路徑。
 * @param {function(ts.Identifier): string} nameOf - identifier 的比對用名稱。
 * @returns {Map<ts.Node, object>} call node → record。
 */
export function extractCalls(sourceFile, path, nameOf) {
  const calls = new Map();
  const occurrences = new Map();
  const visit = (node, chain) => {
    let inner = chain;
    if (isNamedFunction(node)) {
      inner = '';
    } else if (isAnonymousFunction(node)) {
      const anchor = callbackAnchor(node, nameOf);
      const counter = `${subjectOf(node, path)}\u001f${chain}\u001f${anchor}`;
      const occurrence = occurrences.get(counter) ?? 0;
      occurrences.set(counter, occurrence + 1);
      inner = `${chain}>${anchor}#${occurrence}`;
    }
    if (ts.isCallExpression(node) && !ts.isDecorator(node.parent)) {
      const { callee, key } = calleeOf(node, nameOf);
      // 獨立成一個 statement 的呼叫（含 `await f()`）：fact 範圍延伸到 statement 結尾。
      const statement = ts.isExpressionStatement(node.parent)
        ? node.parent
        : (ts.isAwaitExpression(node.parent) && ts.isExpressionStatement(node.parent.parent) ? node.parent.parent : null);
      const subject = subjectOf(node, path);
      calls.set(node, {
        node,
        callee,
        key,
        subject,
        slot: `${subject}\u001f${chain}`,
        hasCallback: (node.arguments ?? []).some((argument) => containsCallback(argument)),
        range: { startByte: byteRange(node).startByte, endByte: byteRange(statement ?? node).endByte },
      });
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, '');
  return calls;
}

/**
 * 依 slot（subject + 所在的匿名 callback）+ callee key 分組，配對後多出來的呼叫成為 CALL_REMOVED / CALL_ADDED。
 *
 * @param {string} path - 檔案路徑。
 * @param {Map<ts.Node, object>} beforeCalls - before 的 call records。
 * @param {Map<ts.Node, object>} afterCalls - after 的 call records。
 * @returns {object[]} facts（含內部欄位 `budgetKey`，輸出前移除）。
 */
export function buildCallFacts(path, beforeCalls, afterCalls) {
  const group = (calls) => {
    const groups = new Map();
    for (const call of [...calls.values()].sort((left, right) => left.range.startByte - right.range.startByte)) {
      const key = `${call.slot}|${call.key}`;
      groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return groups;
  };
  const before = group(beforeCalls);
  const after = group(afterCalls);
  const facts = [];
  const fact = (kind, side, call, index) => facts.push({
    budgetKey: `${kind}\u001f${call.slot}\u001f${call.key}`,
    id: factId([kind, path, call.subject, `${call.callee.text}:${index}`, call.range.startByte, call.range.endByte]),
    kind,
    subject: call.subject,
    properties: { callee: call.callee, changeSide: side },
    provenance: { path, ...call.range },
  });

  for (const [key, beforeGroup] of before) {
    const afterGroup = after.get(key) ?? [];
    for (let index = afterGroup.length; index < beforeGroup.length; index += 1) fact('CALL_REMOVED', 'before', beforeGroup[index], index);
    for (let index = beforeGroup.length; index < afterGroup.length; index += 1) fact('CALL_ADDED', 'after', afterGroup[index], index);
  }
  for (const [key, afterGroup] of after) {
    if (before.has(key)) continue;
    afterGroup.forEach((call, index) => fact('CALL_ADDED', 'after', call, index));
  }
  return facts;
}
