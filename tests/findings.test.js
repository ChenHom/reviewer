import test from 'node:test';
import assert from 'node:assert/strict';

import { factAnchor, findingsFor } from '../src/findings.js';
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

test('檔案層級的單向門與 FULL 檔案各有一個 finding，scope 為整個檔案', () => {
  const findings = findingsFor(file({
    fallback: 'FULL',
    reasons: ['COV-PHP-001:UNRECOGNIZED_PHP_CHANGE', 'AUTHORIZATION_GUARD_REMOVED', 'PROTECTED_PATH'],
  }), options);
  assert.deepEqual(findings.map(({ kind, blocker, scopeHash }) => [kind, blocker, scopeHash]), [
    ['CALL_REMOVED', 'AUTHORIZATION_GUARD_REMOVED', 'php:scope-1'],
    ['FILE', 'PROTECTED_PATH', 'git:abc'],
    ['FILE', 'FULL_REVIEW', 'git:abc'],
  ]);

  const unanalyzed = findingsFor({ path: 'composer.json', track: 'ESCALATED', fallback: 'FULL', reasons: ['UNSUPPORTED_FILE_TYPE'], contentHash: 'git:def', facts: [] }, options);
  assert.deepEqual(unanalyzed.map(({ kind, blocker, subject, scopeHash, location }) => ({ kind, blocker, subject, scopeHash, location })), [
    { kind: 'FILE', blocker: 'FULL_REVIEW', subject: 'composer.json', scopeHash: 'git:def', location: null },
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
