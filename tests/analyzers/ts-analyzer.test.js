import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, scriptKindFor } from '../../analyzers/ts/src/analyze.js';
import { cleanJsxText } from '../../analyzers/ts/src/canonicalizer.js';

const fn = (body, params = 'x') => `export function f(${params}) {\n${body}\n}\n`;

const cases = [
  // [label, path, before, after, expectedReasonOrNull]
  ['format/quotes/semis/trailing comma', 'a.ts', fn("const a = ['x', 'y',];\nreturn a;"), fn('const a = ["x", "y"]; return a'), null],
  ['parens redundant', 'a.ts', fn('return (x + 1) * 2;'), fn('return ((x + 1)) * (2);'), null],
  ['parens precedence change', 'a.ts', fn('return (x + 1) * 2;'), fn('return x + 1 * 2;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['optional chain parens', 'a.ts', fn('return (x?.a).b;'), fn('return x?.a.b;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['numeric forms', 'a.ts', fn('return 1000 + 16;'), fn('return 1_000 + 0x10;'), null],
  ['key quoting', 'a.ts', fn('return { a: 1, "b-c": 2, 3: x };'), fn("return { 'a': 1, 'b-c': 2, '3': x };"), null],
  ['local rename', 'a.ts', fn('const total = x * 2; let i = 0; for (const item of [total]) { i += item; } return i;'), fn('const sum = x * 2; let n = 0; for (const value of [sum]) { n += value; } return n;'), null],
  ['param rename not normalized', 'a.ts', fn('return x;'), fn('return y;', 'y'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['shorthand key changes', 'a.ts', fn('const a = x; return { a };'), fn('const b = x; return { b };'), ['ARRAY_ITEM_ADDED', 'ARRAY_ITEM_REMOVED']],
  ['shorthand expanded same key', 'a.ts', fn('const a = x; return { a };'), fn('const b = x; return { a: b };'), ['ARRAY_ITEM_ADDED', 'ARRAY_ITEM_REMOVED']],
  ['destructuring shorthand rename', 'a.ts', fn('const { a } = x; return a;'), fn('const { b } = x; return b;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['destructuring alias rename', 'a.ts', fn('const { a: p } = x; return p;'), fn('const { a: q } = x; return q;'), null],
  ['swap variables', 'a.ts', fn('let a = 1, b = 2; return a - b;'), fn('let b = 1, a = 2; return a - b;'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['canonical vs global $0 collision', 'a.ts', fn('let a = 1; return a;'), fn('let b = 1; return $0;'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['arrow name inference excluded', 'a.ts', fn('const handler = () => x; return handler.name;'), fn('const cb = () => x; return cb.name;'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['top-level rename not normalized', 'a.js', 'var total = 1; console.log(total);\n', 'var sum = 1; console.log(sum);\n', ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['eval disables rename', 'a.js', fn('const a = 1; eval("a"); return a;'), fn('const b = 1; eval("a"); return b;'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['shadowing rename', 'a.ts', fn('const a = 1; { const a = 2; x(a); } return a;'), fn('const p = 1; { const q = 2; x(q); } return p;'), null],
  ['shadowing wrong', 'a.ts', fn('const a = 1; { const b = 2; x(a); } return a;'), fn('const p = 1; { const q = 2; x(q); } return p;'), ['VARIABLE_CHANGED', 'VARIABLE_CHANGED', 'VARIABLE_CHANGED', 'VARIABLE_CHANGED']],
  ['type annotation change', 'a.ts', fn('const a: number = x; return a;'), fn('const a: any = x; return a;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['as any added', 'a.ts', fn('return x.y;'), fn('return (x as any).y;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['ts-ignore added', 'a.ts', fn('return x.y;'), fn('// @ts-ignore\nreturn x.y;'), ['DIRECTIVE_COMMENT_CHANGED']],
  ['plain comment added', 'a.ts', fn('return x.y;'), fn('// explain\nreturn x.y; /* more */'), null],
  ['pure annotation', 'a.js', 'export const a = make();\n', 'export const a = /*#__PURE__*/ make();\n', ['DIRECTIVE_COMMENT_CHANGED']],
  ['use strict raw', 'a.js', '"use strict";\nfoo();\n', "'use strict';\nfoo();\n", null],
  ['use strict escaped', 'a.js', '"use strict";\nfoo();\n', '"use\\x20strict";\nfoo();\n', 'UNRECOGNIZED_TS_CHANGE'],
  ['string escape same value', 'a.ts', fn("return 'A';"), fn("return '\\x41';"), null],
  ['template vs string', 'a.ts', fn("return 'a';"), fn('return `a`;'), ['LITERAL_CHANGED']],
  ['jsx reformat', 'a.tsx', 'export const A = () => <div className="a"><span>Hello world</span></div>;\n', 'export const A = () => (\n  <div className="a">\n    <span>Hello world</span>\n  </div>\n);\n', null],
  ['jsx text change', 'a.tsx', 'export const A = () => <p>Hello world</p>;\n', 'export const A = () => <p>Hello  world</p>;\n', 'UNRECOGNIZED_TS_CHANGE'],
  ['jsx inline space vs newline', 'a.tsx', 'export const A = () => <p>a <b>b</b></p>;\n', 'export const A = () => <p>a\n<b>b</b></p>;\n', 'UNRECOGNIZED_TS_CHANGE'],
  ['jsx comment text not directive', 'a.tsx', 'export const A = () => <p>// @ts-ignore</p>;\n', 'export const A = () => <p>// @ts-ignore</p>;\n', null],
  ['function to arrow', 'a.ts', 'export const f = function () { return this; };\n', 'export const f = () => { return this; };\n', 'UNRECOGNIZED_TS_CHANGE'],
  ['import order', 'a.ts', "import './a';\nimport './b';\n", "import './b';\nimport './a';\n", 'UNRECOGNIZED_TS_CHANGE'],
  ['empty statements', 'a.ts', fn('x();'), fn('x();;'), null],
  ['let to const', 'a.ts', fn('let a = 1; return a;'), fn('const a = 1; return a;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['operator change', 'a.ts', fn('return x < 1;'), fn('return x <= 1;'), ['BINARY_OPERATOR_CHANGED']],
  ['prefix operator', 'a.ts', fn('return -x;'), fn('return +x;'), 'UNRECOGNIZED_TS_CHANGE'],
  ['type-only import', 'a.ts', "import type { A } from './a';\nexport let x: A;\n", "import { A } from './a';\nexport let x: A;\n", 'UNRECOGNIZED_TS_CHANGE'],
  ['parse error', 'a.ts', fn('return 1;'), fn('return 1 +;'), 'TS_PARSE_ERROR'],
  ['bigint forms', 'a.ts', fn('return 16n;'), fn('return 0x10n;'), null],
  ['catch var rename', 'a.ts', fn('try { x(); } catch (err) { return err; }'), fn('try { x(); } catch (e) { return e; }'), null],
  ['jsx component vs intrinsic', 'a.tsx', 'export function A(x) { const Foo = x; return <Foo />; }\n', 'export function A(x) { const foo = x; return <foo />; }\n', 'UNRECOGNIZED_TS_CHANGE'],
  ['shebang changed', 'a.js', '#!/usr/bin/env node\nfoo();\n', '#!/usr/bin/env bun\nfoo();\n', ['DIRECTIVE_COMMENT_CHANGED', 'DIRECTIVE_COMMENT_CHANGED']],
  ['class semicolon', 'a.ts', 'export class A { a = 1; }\n', 'export class A { a = 1;; }\n', null],
  // 指示移到另一個文字相同的 token 前面：抑制的是另一行，必須產生 fact。
  ['directive moved to identical token', 'a.ts', fn('// @ts-ignore\nfoo(1);\nfoo(2);'), fn('foo(1);\n// @ts-ignore\nfoo(2);'), ['DIRECTIVE_COMMENT_CHANGED', 'DIRECTIVE_COMMENT_CHANGED']],
  // ESLint 的 inline 設定只在 block comment 開頭時才是設定。
  ['eslint inline config added', 'a.js', fn('return eval(x);'), `/* eslint no-eval: "off" */\n${fn('return eval(x);')}`, ['DIRECTIVE_COMMENT_CHANGED']],
  ['eslint global added', 'a.js', fn('return foo;'), `/* global foo: readonly */\n${fn('return foo;')}`, ['DIRECTIVE_COMMENT_CHANGED']],
  ['biome ignore added', 'a.ts', fn('return x;'), `// biome-ignore lint/style: reason\n${fn('return x;')}`, ['DIRECTIVE_COMMENT_CHANGED']],
  ['comment mentioning eslint', 'a.js', fn('return x;'), `// eslint is configured in eslint.config.js\n/* see eslint docs */\n${fn('return x;')}`, null],
  // JS 檔（checkJs）中帶型別的 JSDoc：型別改變要 review，只改說明不用；TS 檔不使用 JSDoc 型別。
  ['jsdoc type changed in js', 'a.js', `/** @type {number} */\nexport let total = 0;\n`, `/** @type {string} */\nexport let total = 0;\n`, ['DIRECTIVE_COMMENT_CHANGED', 'DIRECTIVE_COMMENT_CHANGED']],
  ['jsdoc param type changed in js', 'a.js', `/**\n * @param {number} x - 數量\n */\n${fn('return x;')}`, `/**\n * @param {string} x - 數量\n */\n${fn('return x;')}`, ['DIRECTIVE_COMMENT_CHANGED', 'DIRECTIVE_COMMENT_CHANGED']],
  ['jsdoc type added in js', 'a.js', fn('return x;'), `/** @returns {Promise<{ id: string }>} */\n${fn('return x;')}`, ['DIRECTIVE_COMMENT_CHANGED']],
  ['jsdoc description only in js', 'a.js', `/**\n * @param {number} x - 數量\n */\n${fn('return x;')}`, `/**\n * 計算。\n * @param {number} x - 商品數量\n */\n${fn('return x;')}`, null],
  ['jsdoc type changed in ts', 'a.ts', `/** @type {number} */\nexport let total = 0;\n`, `/** @type {string} */\nexport let total = 0;\n`, null],
  ['directive unchanged with repeated tokens', 'a.ts', fn('foo(1);\n// @ts-ignore\nfoo(2);'), fn('foo(1);\n  // @ts-ignore\n  foo(2);'), null],
  ['only decorator removed', 'a.ts', 'export class A {\n  @Transactional()\n  m() {}\n}\n', 'export class A {\n  m() {}\n}\n', ['ANNOTATION_REMOVED']],
  ['only decorator added', 'a.ts', 'export class A {\n  m() {}\n}\n', 'export class A {\n  @Public()\n  m() {}\n}\n', ['ANNOTATION_ADDED']],
  ['modifier added', 'a.ts', 'export class A {\n  m() {}\n}\n', 'export class A {\n  static m() {}\n}\n', 'UNRECOGNIZED_TS_CHANGE'],
  // 保守：`new Date` 與 `new Date()` 等價，但 canonical 形式不同，不自動判定。
  ['new without parens', 'a.ts', fn('return new Date;'), fn('return new Date();'), 'UNRECOGNIZED_TS_CHANGE'],
];

// expected：null = 等價（COMPLETE、沒有 fact）；字串 = 未解釋的原因或錯誤代碼；陣列 = COMPLETE 且產生這些 fact。
test('TS analyzer：等價判定、fact 解釋與 fail-closed 的邊界', () => {
  for (const [label, path, before, after, expected] of cases) {
    const result = analyze({ path, beforeSource: before, afterSource: after });
    if (!result.ok) {
      assert.equal(result.code, expected, label);
      continue;
    }
    if (Array.isArray(expected)) {
      assert.equal(result.complete, true, label);
      assert.deepEqual(result.facts.map(({ kind }) => kind).sort(), expected, label);
      continue;
    }
    assert.equal(result.reasonCode, expected, label);
    assert.equal(result.complete, expected === null, label);
    assert.equal(result.status, expected === null ? 'COMPLETE' : 'PARTIAL_PARSE', label);
    if (expected === null) assert.deepEqual(result.facts, [], label);
  }
});

test('TS analyzer：副檔名對應與不支援的檔案', () => {
  assert.notEqual(scriptKindFor('a.ts'), null);
  assert.notEqual(scriptKindFor('A.TSX'), null);
  assert.notEqual(scriptKindFor('a.cjs'), null);
  assert.equal(scriptKindFor('a.json'), null);
  assert.equal(scriptKindFor('Makefile'), null);
  assert.deepEqual(analyze({ path: 'a.json', beforeSource: '{}', afterSource: '{}' }).code, 'TS_FILE_TYPE_UNSUPPORTED');
});

test('JSX 文字依 JSX 空白規則正規化', () => {
  assert.equal(cleanJsxText('Hello world'), 'Hello world');
  assert.equal(cleanJsxText('\n    Hello\n    world\n  '), 'Hello world');
  assert.equal(cleanJsxText('\n   \n'), '');
  assert.equal(cleanJsxText(' a '), ' a ');
  assert.equal(cleanJsxText('a\t\n b'), 'a b');
});

test('匿名 callback 各自配對呼叫：呼叫從一個 callback 移到另一個時產生 CALL_REMOVED / CALL_ADDED', () => {
  const routes = (admin, health = '') => `export function routes(router: any, jwt: any, key: string) {\n${health}  router.get('/admin', (req: any, res: any) => {\n${admin}    res.send(1);\n  });\n  router.get('/public', (req: any, res: any) => {\n${admin ? '' : '    jwt.verify(req.token, key);\n'}    res.send(2);\n  });\n}\n`;
  const moved = analyze({ path: 'r.ts', beforeSource: routes('    jwt.verify(req.token, key);\n'), afterSource: routes('') });
  assert.equal(moved.complete, true);
  assert.deepEqual(moved.facts.map(({ kind, properties }) => `${kind}:${properties.callee.text}`).sort(), ['CALL_ADDED:jwt.verify', 'CALL_REMOVED:jwt.verify']);

  // 前面新增另一條路由（錨點不同）不會讓既有 callback 中的呼叫被當成移除。
  const health = "  router.get('/health', (req: any, res: any) => {\n    res.send(0);\n  });\n";
  const added = analyze({ path: 'r.ts', beforeSource: routes('    jwt.verify(req.token, key);\n'), afterSource: routes('    jwt.verify(req.token, key);\n', health) });
  assert.ok(!added.facts.some((fact) => fact.kind === 'CALL_REMOVED'), JSON.stringify(added.facts.map(({ kind }) => kind)));
});
