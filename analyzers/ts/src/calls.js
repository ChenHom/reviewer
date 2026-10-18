import { createHash } from 'node:crypto';

import ts from 'typescript';

import { byteRange, calleeOf, containsCallback, subjectOf } from './syntax.js';

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
 * 抽取檔案中所有 call record。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @param {string} path - 檔案路徑。
 * @param {function(ts.Identifier): string} nameOf - identifier 的比對用名稱。
 * @returns {Map<ts.Node, object>} call node → record。
 */
export function extractCalls(sourceFile, path, nameOf) {
  const calls = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && !ts.isDecorator(node.parent)) {
      const { callee, key } = calleeOf(node, nameOf);
      // 獨立成一個 statement 的呼叫（含 `await f()`）：fact 範圍延伸到 statement 結尾。
      const statement = ts.isExpressionStatement(node.parent)
        ? node.parent
        : (ts.isAwaitExpression(node.parent) && ts.isExpressionStatement(node.parent.parent) ? node.parent.parent : null);
      calls.set(node, {
        node,
        callee,
        key,
        subject: subjectOf(node, path),
        hasCallback: (node.arguments ?? []).some((argument) => containsCallback(argument)),
        range: { startByte: byteRange(node).startByte, endByte: byteRange(statement ?? node).endByte },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/**
 * 依 subject + callee key 分組，配對後多出來的呼叫成為 CALL_REMOVED / CALL_ADDED。
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
      const key = `${call.subject}|${call.key}`;
      groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return groups;
  };
  const before = group(beforeCalls);
  const after = group(afterCalls);
  const facts = [];
  const fact = (kind, side, call, index) => facts.push({
    budgetKey: `${kind}\u001f${call.subject}\u001f${call.key}`,
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
