import test from 'node:test';
import assert from 'node:assert/strict';

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

test('factAnchor 只取不隨位置改變的內容', () => {
  const container = { type: 'argument', callee: callee('middleware', ['this']), argument: 0, keys: [], text: '$this->middleware#0' };
  assert.deepEqual(factAnchor({ kind: 'CALL_ARGUMENT_REMOVED', properties: { callee: callee('middleware', ['this']), argument: 1, value: "'x'" } }), {
    callee: { name: 'middleware', receiver: ['this'], kind: 'method' }, argument: 1,
  });
  assert.deepEqual(factAnchor({ kind: 'BINARY_OPERATOR_CHANGED', properties: { operatorBefore: '<', operatorAfter: '<=', before: '$a  <\n $b', after: '$a <= $b' } }), {
    operator: '<→<=', before: '$a < $b',
  });
  assert.deepEqual(factAnchor({ kind: 'ARRAY_ITEM_REMOVED', properties: { container, key: null, value: "'auth'" } }).container, {
    type: 'argument', keys: [], name: null, callee: { name: 'middleware', receiver: ['this'], kind: 'method' }, argument: 0,
  });
  assert.deepEqual(factAnchor({ kind: 'LITERAL_CHANGED', properties: { container: 'legacy', before: '1', after: '2' } }), {
    container: null, before: '1', after: '2',
  });
  assert.deepEqual(factAnchor({ kind: 'GUARD_REMOVED', properties: { condition: '!$ok', exit: 'throw', scope: {} } }), { condition: '!$ok', exit: 'throw' });
  assert.deepEqual(factAnchor({ kind: 'RETURN_VALUE_CHANGED', properties: { before: 'null', after: '[]', changeSide: 'after', scope: { kind: 'file' } } }), {
    before: 'null', after: '[]',
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
