import test from 'node:test';
import assert from 'node:assert/strict';

import { blockerSources } from '../src/facts/interpreter.js';
import { aiFindingsFor, factAnchor, findingsFor } from '../src/findings.js';
import { DEFAULT_ONE_WAY_DOORS } from '../src/routing.js';

const options = { oneWayDoors: DEFAULT_ONE_WAY_DOORS };
const callee = (name, receiver) => ({ text: `${receiver.join('->')}->${name}`, name, receiver, kind: 'method', optional: false });

const fact = (overrides = {}) => ({
  kind: 'CALL_REMOVED',
  subject: 'OrderService::refund',
  side: 'base',
  startLine: 10,
  endLine: 10,
  description: '移除呼叫 $this->authorize',
  blockers: ['AUTHORIZATION_GUARD_REMOVED'],
  anchor: factAnchor({ kind: 'CALL_REMOVED', properties: { callee: callee('authorize', ['this']) } }),
  scopeHash: 'php:scope-1',
  ...overrides,
});

const file = (overrides = {}) => ({
  path: 'app/OrderService.php',
  track: 'ESCALATED',
  fallback: 'TARGETED',
  reasons: ['AUTHORIZATION_GUARD_REMOVED'],
  contentHash: 'git:abc',
  facts: [fact()],
  ...overrides,
});

test('只有 ESCALATED 的檔案有 finding；單向門 fact 一個 blocker 一個 finding', () => {
  assert.deepEqual(findingsFor(file({ track: 'AI_TRACK' }), options), []);
  assert.deepEqual(findingsFor(file({ track: 'AUTO_PASS' }), options), []);

  const [finding, ...rest] = findingsFor(file({
    facts: [fact(), fact({ kind: 'BINARY_OPERATOR_CHANGED', blockers: ['COMPARISON_OPERATOR_CHANGED'], anchor: { operator: '<→<=' } })],
  }), options);
  assert.equal(rest.length, 0, '非單向門的 fact 沒有 finding');
  assert.match(finding.id, /^[0-9a-f]{64}$/);
  assert.equal(finding.kind, 'CALL_REMOVED');
  assert.equal(finding.blocker, 'AUTHORIZATION_GUARD_REMOVED');
  assert.equal(finding.subject, 'OrderService::refund');
  assert.equal(finding.scopeHash, 'php:scope-1');
  assert.deepEqual(finding.location, { side: 'base', startLine: 10, endLine: 10 });
  assert.equal(finding.ordinal, 0);
});

test('finding id 不含行號：行號改變時 id 不變；subject、anchor 或 blocker 改變時不同', () => {
  const [original] = findingsFor(file(), options);
  const [moved] = findingsFor(file({ facts: [fact({ startLine: 42, endLine: 42, side: 'base' })] }), options);
  assert.equal(moved.id, original.id);

  const [otherMethod] = findingsFor(file({ facts: [fact({ subject: 'OrderService::cancel' })] }), options);
  assert.notEqual(otherMethod.id, original.id);
  const [otherCallee] = findingsFor(file({
    facts: [fact({ anchor: factAnchor({ kind: 'CALL_REMOVED', properties: { callee: callee('authorizeForUser', ['this']) } }) })],
  }), options);
  assert.notEqual(otherCallee.id, original.id);
  const [otherPath] = findingsFor(file({ path: 'app/Other.php' }), options);
  assert.notEqual(otherPath.id, original.id);
});

test('同一個 subject 中 anchor 相同的兩個 finding 以 ordinal 區分，不會合併', () => {
  const findings = findingsFor(file({ facts: [fact({ startLine: 10 }), fact({ startLine: 20 })] }), options);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(({ ordinal }) => ordinal), [0, 1]);
  assert.notEqual(findings[0].id, findings[1].id);
});

test('檔案層級的單向門各有一個 finding，scope 為整個檔案；FULL 本身不是人工項目（交給 AI）', () => {
  const findings = findingsFor(file({
    fallback: 'FULL',
    reasons: ['COV-PHP-001:UNRECOGNIZED_PHP_CHANGE', 'AUTHORIZATION_GUARD_REMOVED', 'PROTECTED_PATH'],
  }), options);
  assert.deepEqual(findings.map(({ kind, blocker, scopeHash }) => [kind, blocker, scopeHash]), [
    ['CALL_REMOVED', 'AUTHORIZATION_GUARD_REMOVED', 'php:scope-1'],
    ['FILE', 'PROTECTED_PATH', 'git:abc'],
  ]);

  const invalid = findingsFor({ path: 'composer.json', track: 'ESCALATED', fallback: 'FULL', reasons: ['UNSUPPORTED_FILE_TYPE', 'POLICY_CONFIG_INVALID'], contentHash: 'git:def', facts: [] }, options);
  assert.deepEqual(invalid.map(({ kind, blocker, subject, scopeHash, location }) => ({ kind, blocker, subject, scopeHash, location })), [
    { kind: 'FILE', blocker: 'POLICY_CONFIG_INVALID', subject: 'composer.json', scopeHash: 'git:def', location: null },
  ]);

  // 沒有 scope hash 的 fact（例如沒有輸出 scope 的 analyzer）以整個檔案為範圍
  const [fallback] = findingsFor(file({ facts: [fact({ scopeHash: null })] }), options);
  assert.equal(fallback.scopeHash, 'git:abc');
});

test('factAnchor 只取不隨位置與 head 側的值改變的內容', () => {
  const container = { type: 'argument', callee: callee('middleware', ['this']), argument: 0, keys: [], text: '$this->middleware#0' };
  assert.deepEqual(factAnchor({ kind: 'CALL_ARGUMENT_REMOVED', properties: { callee: callee('middleware', ['this']), argument: 1, value: "'x'" } }), {
    callee: { name: 'middleware', receiver: ['this'], kind: 'method' }, argument: 1,
  });
  // 變更後的運算子與運算式不列入：作者再改一次運算子時 finding id 不變（豁免由 scope hash 失效）。
  assert.deepEqual(factAnchor({ kind: 'BINARY_OPERATOR_CHANGED', properties: { operatorBefore: '<', operatorAfter: '<=', before: '$a  <\n $b', after: '$a <= $b' } }), {
    operator: '<', before: '$a < $b',
  });
  assert.deepEqual(factAnchor({ kind: 'ARRAY_ITEM_REMOVED', properties: { container, key: null, value: "'auth'" } }).container, {
    type: 'argument', keys: [], name: null, callee: { name: 'middleware', receiver: ['this'], kind: 'method' }, argument: 0,
  });
  assert.deepEqual(factAnchor({ kind: 'ARRAY_ITEM_REMOVED', properties: { container, key: null, value: "'auth'" } }).value, "'auth'");
  assert.equal('value' in factAnchor({ kind: 'ARRAY_ITEM_ADDED', properties: { container, key: null, value: "'auth'" } }), false);
  assert.deepEqual(factAnchor({ kind: 'LITERAL_CHANGED', properties: { container: 'legacy', before: '1', after: '2' } }), {
    container: null, before: '1',
  });
  assert.deepEqual(factAnchor({ kind: 'GUARD_REMOVED', properties: { condition: '!$ok', exit: 'throw', scope: {} } }), { condition: '!$ok', exit: 'throw' });
  assert.deepEqual(factAnchor({ kind: 'GUARD_ADDED', properties: { condition: '!$ok', exit: 'throw' } }), { exit: 'throw' });
  assert.deepEqual(factAnchor({ kind: 'RETURN_VALUE_CHANGED', properties: { before: 'null', after: '[]', changeSide: 'after', scope: { kind: 'file' } } }), {
    before: 'null',
  });
  // 其他 fact 的 callee / container 只取結構（不含顯示文字與 `outer`）；新增類不含 value。
  assert.deepEqual(factAnchor({ kind: 'VARIABLE_CHANGED', properties: { container: { ...container, outer: container }, before: '$a', after: '$b' } }), {
    container: { type: 'argument', keys: [], name: null, callee: { name: 'middleware', receiver: ['this'], kind: 'method' }, argument: 0 }, before: '$a',
  });
  assert.deepEqual(factAnchor({ kind: 'ANNOTATION_ADDED', properties: { callee: callee('Public', []), value: '@Public()' } }), {
    callee: { name: 'Public', receiver: [], kind: 'method' },
  });
  assert.deepEqual(factAnchor({ kind: 'CALL_ADDED', properties: {} }), { callee: null });
});

test('AI finding：依路由與 AI 狀態產生，綁定整個檔案的內容', () => {
  const file = (track, ai) => ({ path: 'a.js', track, contentHash: 'git:abc', ai });
  const concern = (severity, title = '問題') => ({ title, detail: '說明', severity, side: 'head', startLine: 0, endLine: 0, standard: '' });
  assert.deepEqual(aiFindingsFor({ path: 'a.js', track: 'AI_TRACK' }), []);
  assert.deepEqual(aiFindingsFor(file('AUTO_PASS', { status: 'NEEDS_HUMAN', concerns: [] })), []);
  assert.deepEqual(aiFindingsFor(file('AI_TRACK', { status: 'PASS', concerns: [concern('medium')] })), []);
  assert.deepEqual(aiFindingsFor(file('ESCALATED', { status: 'FAILED', error: 'AI_REFUSED', concerns: [] })), []);
  assert.deepEqual(aiFindingsFor(file('ESCALATED', { status: 'PASS', concerns: [concern('low')] })), []);

  const [needsHuman] = aiFindingsFor(file('AI_TRACK', { status: 'NEEDS_HUMAN', summary: '需要確認', concerns: [concern('low')] }));
  assert.deepEqual({ ...needsHuman, id: undefined }, {
    id: undefined, path: 'a.js', subject: 'a.js', kind: 'AI', scopeHash: 'git:abc', blocker: 'AI_NEEDS_HUMAN', anchor: 'AI_NEEDS_HUMAN', location: null, description: '需要確認', ordinal: 0,
  });
  const twice = aiFindingsFor(file('ESCALATED', { status: 'PASS', concerns: [concern('medium'), concern('high')] }));
  assert.deepEqual(twice.map(({ blocker, anchor, ordinal, location }) => [blocker, anchor, ordinal, location]), [
    ['AI_CONCERN', '問題', 0, null],
    ['AI_CONCERN', '問題', 1, null],
  ]);
  assert.notEqual(twice[0].id, twice[1].id);
});

test('設定把帶參數的代碼列為單向門時，finding 與路由一樣以基本代碼比對', () => {
  const file = {
    path: 'a.js',
    track: 'ESCALATED',
    contentHash: 'git:abc',
    reasons: ['FACT_UNHANDLED:ts-1', 'ANALYZER_ERROR:spawn php ENOENT'],
    facts: [{ kind: 'CALL_ADDED', subject: 'f', side: 'head', startLine: 1, endLine: 1, description: '新增呼叫 x', blockers: ['FACT_UNHANDLED:ts-1'], anchor: { callee: null }, scopeHash: 'ts:1' }],
  };
  const findings = findingsFor(file, { oneWayDoors: [...DEFAULT_ONE_WAY_DOORS, 'FACT_UNHANDLED', 'ANALYZER_ERROR'] });
  assert.deepEqual(findings.map(({ kind, blocker, anchor }) => [kind, blocker, anchor]), [
    ['CALL_ADDED', 'FACT_UNHANDLED:ts-1', { callee: null }],
    ['FILE', 'ANALYZER_ERROR:spawn php ENOENT', 'ANALYZER_ERROR:spawn php ENOENT'],
  ]);
});

test('policyDigest 只隨產生該 blocker 的規則改變', () => {
  const sources = (version, extra = {}) => ({ AUTHORIZATION_GUARD_REMOVED: [`php-laravel-authorization@${version}`], ...extra });
  const [base] = findingsFor(file({ facts: [fact({ blockerSources: sources('2.0.0') })] }), options);
  const [upgraded] = findingsFor(file({ facts: [fact({ blockerSources: sources('2.1.0') })] }), options);
  const [unrelated] = findingsFor(file({ facts: [fact({ blockerSources: sources('2.0.0', { OTHER: ['x@9'] }) })] }), options);
  assert.equal(typeof base.policyDigest, 'string');
  assert.notEqual(base.policyDigest, upgraded.policyDigest);
  assert.equal(base.policyDigest, unrelated.policyDigest);
  // id 不含 policy：規則升級時是同一個 finding，只有豁免失效。
  assert.equal(base.id, upgraded.id);

  const fileLevel = (configDigest) => findingsFor({
    path: '.reviewer.json', track: 'ESCALATED', fallback: 'FULL', reasons: ['POLICY_FILE_CHANGED'], contentHash: 'git:1', facts: [],
  }, { ...options, configDigest })[0];
  assert.notEqual(fileLevel('a').policyDigest, fileLevel('b').policyDigest);
  assert.equal(fileLevel('a').policyDigest, fileLevel('a').policyDigest);
});

test('blockerSources：每個 blocker 由哪些 interpreter 產生；沒有 interpreter 處理時為整組', () => {
  const interpreter = (id, result) => ({ id, version: '1.0.0', interpret: () => result });
  const lock = interpreter('lock', { handled: true, blockers: ['ROW_LOCK_REMOVED'] });
  const tx = interpreter('tx', { handled: true, blockers: ['TRANSACTION_BOUNDARY_REMOVED', 'ROW_LOCK_REMOVED'] });
  const skip = interpreter('skip', { handled: false });
  const fact = { id: 'f-1', kind: 'CALL_REMOVED', subject: 'A::b', properties: {} };
  assert.deepEqual(blockerSources(fact, [lock, tx, skip]), {
    ROW_LOCK_REMOVED: ['lock@1.0.0', 'tx@1.0.0'],
    TRANSACTION_BOUNDARY_REMOVED: ['tx@1.0.0'],
  });
  // 沒有 interpreter 處理：整組 interpreter 的 digest（順序無關；新增 interpreter 時改變）。
  const unhandled = blockerSources(fact, [skip, interpreter('other', null)]);
  assert.match(unhandled['FACT_UNHANDLED:f-1'][0], /^set:[0-9a-f]{16}$/);
  assert.deepEqual(blockerSources(fact, [interpreter('other', null), skip]), unhandled);
  assert.notDeepEqual(blockerSources(fact, [skip, interpreter('other', null), interpreter('third', null)]), unhandled);
  const failing = { id: 'boom', version: '2', interpret: () => { throw new Error('x'); } };
  assert.deepEqual(blockerSources(fact, [failing]), { 'ANALYZER_FACT_INTERPRETER_FAILED:boom:f-1': ['boom@2'] });
  assert.match(blockerSources(fact, [{ id: 'bad' }]).ANALYZER_FACT_INTERPRETER_SET_INVALID[0], /^set:/);
  assert.match(blockerSources(fact, null).ANALYZER_FACT_INTERPRETER_SET_INVALID[0], /^set:/);
});
