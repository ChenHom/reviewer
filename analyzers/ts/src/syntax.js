import { Buffer } from 'node:buffer';

import ts from 'typescript';

/**
 * TS analyzer 的語法 helpers：結構化 callee、subject、字面值判斷、子節點欄位與 byte offset。
 * callee / container 的形狀與 PHP analyzer 相同（fact schema v2，見 `src/facts/structured.js`）。
 */

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

/**
 * 原始碼片段（壓成單一空白）。
 *
 * @param {ts.Node} node - node。
 * @returns {string} 文字。
 */
export function textOf(node) {
  return node.getText().replace(/\s+/g, ' ').trim();
}

/**
 * 去掉不影響語意的括號（與 canonicalizer 相同：optional chain 外的括號保留）。
 *
 * @param {ts.Node} node - node。
 * @returns {ts.Node} 內層 node。
 */
export function unwrapParens(node) {
  let current = node;
  while (current?.kind === ts.SyntaxKind.ParenthesizedExpression && !ts.isOptionalChain(current.expression)) {
    current = current.expression;
  }
  while (current?.kind === ts.SyntaxKind.ParenthesizedType) current = current.type;
  return current;
}

/**
 * property key 的字串值；不是簡單 key 時為 null。
 *
 * @param {ts.Node|undefined} name - property name。
 * @returns {string|null} key。
 */
export function propertyKey(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}

/**
 * 字面值：字串（statement 位置的指示除外）、數字、bigint、沒有插值的 template、true / false / null、帶正負號的數字。
 *
 * @param {ts.Node} node - node。
 * @returns {boolean} 是否為字面值。
 */
export function isLiteral(node) {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
      return node.parent?.kind !== ts.SyntaxKind.ExpressionStatement;
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    case ts.SyntaxKind.PrefixUnaryExpression:
      return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)
        && (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand));
    default:
      return false;
  }
}

/**
 * 編譯期即可決定的值：字面值、`undefined`、只含這些值的陣列 / 物件。
 *
 * @param {ts.Node} input - 運算式。
 * @returns {boolean} 是否為常數。
 */
export function isConstant(input) {
  const node = unwrapParens(input);
  if (isLiteral(node)) return true;
  if (ts.isIdentifier(node)) return node.text === 'undefined';
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => isConstant(element));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => ts.isPropertyAssignment(property)
      && propertyKey(property.name) !== null
      && isConstant(property.initializer));
  }
  return false;
}

/**
 * 是否為 call / new。
 *
 * @param {ts.Node|undefined} node - node。
 * @returns {boolean} 是否為呼叫。
 */
export function isCall(node) {
  return Boolean(node) && (ts.isCallExpression(node) || ts.isNewExpression(node));
}

/**
 * 呼叫的 receiver 運算式（`x.m()` 的 `x`）；沒有時為 null。
 *
 * @param {ts.Node} call - call expression。
 * @returns {ts.Node|null} receiver。
 */
export function receiverOfCall(call) {
  if (!ts.isCallExpression(call)) return null;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : null;
}

/**
 * 運算式中是否含有 callback（function、arrow function、class expression）。
 *
 * @param {ts.Node} node - node。
 * @returns {boolean} 是否含有 callback。
 */
export function containsCallback(node) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isClassExpression(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * receiver 的名稱路徑（`this.db` → `['this', 'db']`）；無法化成路徑時為 null。
 *
 * @param {ts.Node} input - receiver 運算式。
 * @param {function(ts.Identifier): string} nameOf - identifier 的比對用名稱（canonical 或原名）。
 * @returns {{segments: string[], keys: string[]}|null} 路徑。
 */
function receiverPath(input, nameOf) {
  let node = unwrapParens(input);
  while (node && ts.isNonNullExpression(node)) node = unwrapParens(node.expression);
  if (!node) return null;
  if (ts.isIdentifier(node)) return { segments: [node.text], keys: [nameOf(node)] };
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { segments: ['this'], keys: ['this'] };
  if (node.kind === ts.SyntaxKind.SuperKeyword) return { segments: ['super'], keys: ['super'] };
  const name = memberName(node);
  if (name !== null) {
    const base = receiverPath(node.expression, nameOf);
    return base ? { segments: [...base.segments, name], keys: [...base.keys, name] } : null;
  }
  return null;
}

/**
 * `a.b` / `a['b']` 的成員名稱；不是簡單成員時為 null。
 *
 * @param {ts.Node} node - node。
 * @returns {string|null} 名稱。
 */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

/**
 * 結構化 callee 與比對用 key。
 *
 * @param {ts.Node} call - CallExpression、NewExpression 或 Decorator 的運算式。
 * @param {function(ts.Identifier): string} [nameOf] - identifier 的比對用名稱。
 * @returns {{callee: object, key: string}} callee 與 key。
 */
export function calleeOf(call, nameOf = (node) => `I:${node.text}`) {
  const constructor = ts.isNewExpression(call);
  const expression = ts.isCallExpression(call) || constructor ? call.expression : call;
  const kind = constructor ? 'constructor' : 'function';
  const optional = Boolean(call.questionDotToken);

  if (expression.kind === ts.SyntaxKind.SuperKeyword) {
    return { callee: { text: 'super', name: 'super', receiver: [], kind: 'function', optional: false }, key: 'super' };
  }
  if (ts.isIdentifier(expression)) {
    return {
      callee: { text: constructor ? `new ${expression.text}` : expression.text, name: expression.text, receiver: [], kind, optional },
      key: `${constructor ? 'new ' : ''}${nameOf(expression)}`,
    };
  }
  const name = memberName(expression);
  if (name !== null) {
    const memberOptional = optional || Boolean(expression.questionDotToken);
    const base = unwrapParens(expression.expression);
    const path = isCall(base) ? null : receiverPath(base, nameOf);
    const separator = memberOptional ? '?.' : '.';
    const text = path ? `${path.segments.join('.')}${separator}${name}` : `${separator}${name}`;
    return {
      callee: {
        text: constructor ? `new ${text}` : text,
        name,
        receiver: path ? path.segments : null,
        kind: constructor ? 'constructor' : 'method',
        optional: memberOptional,
      },
      key: `${constructor ? 'new ' : ''}${path ? path.keys.join('.') : ''}${separator}${name}`,
    };
  }
  const text = textOf(expression);
  return { callee: { text, name: text, receiver: null, kind, optional }, key: `${constructor ? 'new ' : ''}${text}` };
}

/**
 * Decorator 的 callee（`@UseGuards(A)` → `UseGuards`、`@Injectable` → `Injectable`）。
 *
 * @param {ts.Decorator} decorator - decorator。
 * @returns {object} 結構化 callee。
 */
export function decoratorCallee(decorator) {
  return calleeOf(unwrapParens(decorator.expression)).callee;
}

/**
 * function-like node 的名稱：宣告名稱，或匿名 function / arrow 被指定給的變數、property 名稱。
 *
 * @param {ts.Node} node - function-like node。
 * @returns {string|null} 名稱。
 */
function functionName(node) {
  if (node.kind === ts.SyntaxKind.Constructor) return 'constructor';
  if (node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) return 'static';
  if (node.name) return propertyKey(node.name) ?? textOf(node.name);
  const parent = node.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.initializer === node) {
    return propertyKey(parent.name);
  }
  return null;
}

/**
 * 沒有名稱的 function-like（匿名 callback）：不會成為 subject，其中的呼叫歸屬於外層的具名 function。
 *
 * @param {ts.Node} node - node。
 * @returns {boolean} 是否為匿名 function-like。
 */
export function isAnonymousFunction(node) {
  return FUNCTION_LIKE.has(node.kind) && functionName(node) === null;
}

/**
 * 具名的 function-like（subject 的邊界）。
 *
 * @param {ts.Node} node - node。
 * @returns {boolean} 是否為具名 function-like。
 */
export function isNamedFunction(node) {
  return FUNCTION_LIKE.has(node.kind) && functionName(node) !== null;
}

/**
 * node 所屬的具名 function-like 與 class（與 PHP 的 subject 規則相同）。
 *
 * @param {ts.Node} node - node。
 * @returns {{subject: string|null, scope: ts.Node|null}} subject（`Class.method` 或 function 名稱）與 scope node。
 */
export function scopeOf(node) {
  let scope = null;
  let name = null;
  for (let current = node; current; current = current.parent) {
    if (scope === null && FUNCTION_LIKE.has(current.kind)) {
      name = functionName(current);
      if (name !== null) scope = current;
      continue;
    }
    if (scope !== null && ts.isClassLike(current)) {
      const className = current.name?.text;
      return { subject: className ? `${className}.${name}` : name, scope };
    }
  }
  return { subject: name, scope };
}

/**
 * node 的 subject；不在具名 function 內時為檔案路徑。
 *
 * @param {ts.Node} node - node。
 * @param {string} path - 檔案路徑。
 * @returns {string} subject。
 */
export function subjectOf(node, path) {
  return scopeOf(node).subject ?? path;
}

/**
 * 子節點欄位：`[欄位名稱, Node 或 NodeArray]`，只含 forEachChild 走訪到的子節點。
 *
 * @param {ts.Node} node - node。
 * @returns {Array<[string, ts.Node|ts.NodeArray]>} 欄位。
 */
export function childSlots(node) {
  const children = new Set();
  ts.forEachChild(node, (child) => {
    children.add(child);
  }, (array) => {
    children.add(array);
  });
  return Object.keys(node)
    .filter((key) => key !== 'parent' && children.has(node[key]))
    .map((key) => [key, node[key]]);
}

/**
 * UTF-16 index 轉成 UTF-8 byte offset。
 *
 * @param {string} text - 原始碼。
 * @param {number} index - 字元 index。
 * @returns {number} byte offset。
 */
export function byteOffset(text, index) {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

/**
 * node 的 byte 範圍（不含前導 trivia）。
 *
 * @param {ts.Node} node - node。
 * @returns {{startByte: number, endByte: number}} 範圍。
 */
export function byteRange(node) {
  const text = node.getSourceFile().text;
  return { startByte: byteOffset(text, node.getStart()), endByte: byteOffset(text, node.end) };
}
