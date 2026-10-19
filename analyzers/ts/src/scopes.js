import ts from 'typescript';

/**
 * Scope-aware 區域變數改名正規化：function 內一致的區域變數改名視為等價。
 *
 * 只正規化宣告在 function-like body 內的區域變數（`let` / `const` / `var`、解構、`catch` 變數）。
 * 以下不正規化（與 PHP analyzer 相同，寧可要求 review）：
 *
 * - 參數（`fn.toString()` 與部分 DI 框架看得到參數名稱）與參數中的解構；
 * - 頂層變數（script 中的頂層 `var` / function 是全域變數）；
 * - 會被賦予匿名 function / class / arrow 的變數（`const f = () => {}` 會讓 `f.name === 'f'`）；
 * - 檔案中有 direct `eval(...)` 或 `with` 時，整個檔案都不正規化。
 *
 * 名稱比對以 TypeScript checker 解析 symbol，所以 shadowing、closure 都依實際的 scope 解析。
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

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * 以單一檔案建立 program，取得 type checker（不載入 lib、不解析 import）。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @returns {ts.TypeChecker} checker。
 */
export function checkerFor(sourceFile) {
  const options = { noLib: true, noResolve: true, allowJs: true, types: [], target: ts.ScriptTarget.Latest };
  const host = {
    getSourceFile: (fileName) => (fileName === sourceFile.fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === sourceFile.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram({ rootNames: [sourceFile.fileName], options, host }).getTypeChecker();
}

/**
 * 去掉括號與型別包裝（`as`、`satisfies`、`!`、`<T>x`）。
 *
 * @param {ts.Expression} expression - 運算式。
 * @returns {ts.Expression} 內層運算式。
 */
function unwrap(expression) {
  let current = expression;
  while (
    current
    && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * 是否為匿名 function / class / arrow（賦值給變數時會以變數名稱命名）。
 *
 * @param {ts.Expression|undefined} expression - 運算式。
 * @returns {boolean} 是否為匿名定義。
 */
function isAnonymousDefinition(expression) {
  const inner = unwrap(expression);
  return Boolean(inner) && (
    ts.isArrowFunction(inner)
    || ((ts.isFunctionExpression(inner) || ts.isClassExpression(inner)) && !inner.name)
  );
}

/**
 * node 是否在某個 function-like body 內（不經過參數）。
 *
 * @param {ts.Node} node - 宣告名稱。
 * @returns {boolean} 是否為 function 內的區域宣告。
 */
function isLocalDeclaration(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isParameter(current)) return false;
    if (FUNCTION_LIKE.has(current.kind)) return true;
    if (ts.isSourceFile(current) || ts.isModuleBlock(current)) return false;
  }
  return false;
}

/**
 * 檔案中是否有讓 scope 無法靜態解析的寫法（direct eval、with）。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @returns {boolean} 是否有。
 */
function hasDynamicScope(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      node.kind === ts.SyntaxKind.WithStatement
      || (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === 'eval')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * 計算可改名正規化的區域變數 canonical 名稱（依宣告出現順序編號）。
 *
 * @param {ts.SourceFile} sourceFile - source file。
 * @param {ts.TypeChecker} checker - checker。
 * @returns {Map<object, string>} symbol → canonical 名稱。
 */
export function canonicalNames(sourceFile, checker) {
  const names = new Map();
  if (hasDynamicScope(sourceFile)) return names;

  const declarations = [];
  const excluded = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && (ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent)) && node.parent.name === node) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        if (isLocalDeclaration(node)) declarations.push(symbol);
        else excluded.add(symbol);
        if (isAnonymousDefinition(node.parent.initializer)) excluded.add(symbol);
      }
    }
    if (
      ts.isBinaryExpression(node)
      && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
      && ts.isIdentifier(unwrap(node.left))
      && isAnonymousDefinition(node.right)
    ) {
      const symbol = checker.getSymbolAtLocation(unwrap(node.left));
      if (symbol) excluded.add(symbol);
    }
    if (ts.isShorthandPropertyAssignment(node) && isAnonymousDefinition(node.objectAssignmentInitializer)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node);
      if (symbol) excluded.add(symbol);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const symbol of declarations) {
    if (excluded.has(symbol) || names.has(symbol)) continue;
    // 同一個名稱也有其他種類的宣告（function、class、參數等）時不正規化。
    const onlyVariables = (symbol.declarations ?? []).every((declaration) => (
      (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) && isLocalDeclaration(declaration.name)
    ));
    if (onlyVariables) names.set(symbol, String(names.size));
  }
  return names;
}
