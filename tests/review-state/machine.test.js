import test from 'node:test';
import assert from 'node:assert/strict';

import { stateKeys } from '../../src/review-state/codec.js';
import { DASHBOARD_MARKER, escapeText, formatDashboard, renderDashboard, threadTargets } from '../../src/review-state/dashboard.js';
import { updateReviewState } from '../../src/review-state/index.js';
import { ITEM_STATE, buildItems, checkResult, computeState, fingerprint, itemLabel } from '../../src/review-state/machine.js';

const sha = (n) => String(n).repeat(40).slice(0, 40);
const DOOR = 'd00d'.padEnd(64, 'a');
const LOCK = 'b10c'.padEnd(64, 'b');
const keys = stateKeys('test-key');
const PR = { number: 42, user: { login: 'author' } };

/** 單向門 finding。 */
const door = (overrides = {}) => ({
  id: DOOR,
  path: 'app/WalletService.php',
  subject: 'WalletService::debit',
  kind: 'CALL_REMOVED',
  blocker: 'TRANSACTION_BOUNDARY_REMOVED',
  scopeHash: 'php:scope-1',
  policyDigest: 'policy-1',
  location: { side: 'base', startLine: 42, endLine: 44 },
  description: '移除呼叫 \\DB::transaction',
  ...overrides,
});
const aiFinding = (blocker, description = 'AI：可能少了 null 檢查') => ({ kind: 'AI', blocker, description, path: 'src/a.ts' });
/** 報表：預設一個單向門檔案、一個 AI 通過的檔案、一個機械審查略過的檔案。 */
const report = (head, overrides = {}) => ({
  head: { sha: head },
  config: { digest: null },
  ai: { model: 'm' },
  files: [
    { path: 'app/WalletService.php', track: 'ESCALATED', contentHash: 'git:w1', needsHuman: true, findings: [door()] },
    { path: 'src/ok.ts', track: 'AI_TRACK', contentHash: 'git:ok', needsHuman: false, ai: { status: 'PASS' }, findings: [] },
    { path: 'src/skip.ts', track: 'AUTO_PASS', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', contentHash: 'git:s', needsHuman: false, findings: [] },
  ],
  ...overrides,
});
const comment = (id, body, login = 'alice', overrides = {}) => ({ id, body, user: { login, id: id * 10, type: 'User' }, created_at: `t${id}`, updated_at: `t${id}`, ...overrides });
const permissions = { alice: 'write', bob: 'maintain', reader: 'read' };

/** 以上一版儀表板為輸入跑一次（模擬 workflow）。 */
const step = (current, dashboard, comments = [], extra = {}) => updateReviewState({
  report: current, pr: { ...PR, head: { sha: current.head.sha } }, dashboard, comments, permissions, keys, ...extra,
});
const stateOf = (result, label) => result.items.find((item) => item.label.startsWith(label))?.state;

test('buildItems：單向門各自一項；AI 的 finding 與沒有 finding 但需要人工的檔案以檔案為單位', () => {
  const items = buildItems(report(sha(1), {
    files: [
      { path: 'app/W.php', track: 'ESCALATED', contentHash: 'git:1', needsHuman: true, findings: [door(), door({ id: LOCK, blocker: 'ROW_LOCK_REMOVED' }), aiFinding('AI_CONCERN')] },
      { path: 'src/a.ts', track: 'AI_TRACK', contentHash: 'git:2', needsHuman: true, ai: {}, findings: [aiFinding('AI_CONCERN', 'x'), aiFinding('AI_CONCERN', 'y')] },
      { path: 'src/b.ts', track: 'AI_TRACK', contentHash: 'git:3', needsHuman: true, ai: {}, findings: [aiFinding('AI_NEEDS_HUMAN')] },
      { path: 'src/c.ts', track: 'AI_TRACK', contentHash: 'git:4', needsHuman: true, ai: {}, findings: [aiFinding('AI_REVIEW_FAILED', null), aiFinding('AI_CONCERN')] },
      { path: 'src/d.ts', track: 'AI_TRACK', contentHash: 'git:5', needsHuman: true, findings: [] },
      // 不認得的路由（fail-closed 成 ESCALATED）但沒有 finding：仍要有項目可以確認。
      { path: 'src/e.ts', track: 'WEIRD', contentHash: 'git:6', findings: [] },
      { path: 'src/f.ts', track: 'AI_TRACK', contentHash: 'git:7', needsHuman: false, ai: { status: 'FIXED' }, findings: [] },
      { path: 'src/g.ts', track: 'AUTO_PASS', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', contentHash: 'git:8', findings: [] },
    ],
  }));
  const summary = [...items.values()].map(({ kind, path, blocker, concerns }) => [kind, path, blocker, concerns ?? null]);
  assert.deepEqual(summary, [
    ['DOOR', 'app/W.php', 'TRANSACTION_BOUNDARY_REMOVED', null],
    ['DOOR', 'app/W.php', 'ROW_LOCK_REMOVED', null],
    ['FILE', 'app/W.php', 'AI_CONCERN', 1],
    ['FILE', 'src/a.ts', 'AI_CONCERN', 2],
    ['FILE', 'src/b.ts', 'AI_NEEDS_HUMAN', 1],
    ['FILE', 'src/c.ts', 'AI_REVIEW_FAILED', 2],
    ['FILE', 'src/d.ts', 'AI_REVIEW_MISSING', 0],
    ['FILE', 'src/e.ts', 'HUMAN_REVIEW_REQUIRED', 0],
  ]);
  const doorItem = items.get(DOOR);
  assert.equal(doorItem.scope, fingerprint('php:scope-1'));
  assert.equal(doorItem.policy, fingerprint('policy-1'));
  // 檔案層級的項目綁定整個檔案的內容。
  const fileItem = [...items.values()].find((item) => item.path === 'src/a.ts');
  assert.equal(fileItem.scope, fingerprint('git:2'));
  assert.equal(fileItem.description, 'x；y');
  // 沒有 scopeHash / policyDigest 的 finding 以檔案內容與 blocker 代替。
  const fallback = buildItems(report(sha(1), { files: [{ path: 'a', track: 'ESCALATED', contentHash: 'git:9', findings: [door({ scopeHash: null, policyDigest: null })] }] }));
  assert.equal(fallback.get(DOOR).scope, fingerprint('git:9'));
  assert.deepEqual(buildItems({}), new Map());
});

test('buildItems：只有機械審查略過與 AI 審查通過可以不產生項目；不認得或不一致的組合一律需要確認', () => {
  const kinds = (file) => [...buildItems(report(sha(1), { files: [{ path: 'x', contentHash: 'git:x', findings: [], ...file }] })).values()]
    .map(({ blocker }) => blocker);
  assert.deepEqual(kinds({ track: 'AUTO_PASS', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', needsHuman: false }), []);
  assert.deepEqual(kinds({ track: 'AI_TRACK', needsHuman: false, ai: { status: 'PASS' } }), []);
  // 不認得的路由，即使 needsHuman 為 false。
  assert.deepEqual(kinds({ track: 'SOMETHING_NEW', needsHuman: false }), ['HUMAN_REVIEW_REQUIRED']);
  // AUTO_PASS 但決策不是 NOT_SELECTED，或 needsHuman 為 true。
  assert.deepEqual(kinds({ track: 'AUTO_PASS', decision: 'HUMAN_REVIEW_REQUIRED', needsHuman: false }), ['HUMAN_REVIEW_REQUIRED']);
  assert.deepEqual(kinds({ track: 'AUTO_PASS', needsHuman: false }), ['HUMAN_REVIEW_REQUIRED']);
  assert.deepEqual(kinds({ track: 'AUTO_PASS', decision: 'NOT_SELECTED_FOR_HUMAN_REVIEW', needsHuman: true }), ['HUMAN_REVIEW_REQUIRED']);
  // AI_TRACK 的 needsHuman 為 false，但沒有 AI 結果或結果不是通過。
  assert.deepEqual(kinds({ track: 'AI_TRACK', needsHuman: false }), ['AI_REVIEW_MISSING']);
  assert.deepEqual(kinds({ track: 'AI_TRACK', needsHuman: false, ai: { status: 'NEEDS_HUMAN' } }), ['HUMAN_REVIEW_REQUIRED']);
  // ESCALATED 但沒有任何 finding。
  assert.deepEqual(kinds({ track: 'ESCALATED', needsHuman: true }), ['HUMAN_REVIEW_REQUIRED']);
  // 這種報表的 Check 不會通過。
  const result = step(report(sha(1), { files: [{ path: 'x', track: 'SOMETHING_NEW', needsHuman: false, contentHash: 'git:x', findings: [] }] }), null);
  assert.equal(result.check.conclusion, 'failure');
});

test('保存的確認每次都重新檢查權限：權限被移除或門檻提高時不再採用', () => {
  const first = step(report(sha(1)), null);
  const comments = [comment(3, '/reviewer ack F1-d00d@1111111 已確認')];
  const acked = step(report(sha(1)), first.dashboard.body, comments);
  assert.equal(stateOf(acked, 'F1'), 'ACKNOWLEDGED');
  for (const [label, extra] of [
    ['降為 read', { permissions: { alice: 'read' } }],
    ['沒有權限資料', { permissions: {} }],
    ['門檻提高到 maintain', { minPermission: 'maintain' }],
  ]) {
    const result = step(report(sha(1)), acked.dashboard.body, comments, extra);
    assert.equal(stateOf(result, 'F1'), 'OPEN', label);
    assert.deepEqual(result.notes, [{ code: 'ACKS_WITHDRAWN', count: 1 }], label);
    assert.match(result.dashboard.body, /確認者目前的權限不足/, label);
  }
  // 權限足夠（maintain 門檻下的 maintain）時仍有效。
  assert.equal(stateOf(step(report(sha(1)), acked.dashboard.body, comments, { permissions: { alice: 'maintain' }, minPermission: 'maintain' }), 'F1'), 'ACKNOWLEDGED');
});

test('流程：待確認 → 確認 → 程式碼改變後重新開啟 → 再確認 → 修正 → 再次出現', () => {
  const head1 = report(sha(1));
  const first = step(head1, null);
  assert.equal(first.previousState.status, 'absent');
  assert.deepEqual(first.items.map(({ label, state }) => [label, state]), [['F1-d00d', 'OPEN']]);
  assert.equal(first.check.conclusion, 'failure');
  assert.equal(first.check.headSha, sha(1));
  assert.ok(first.dashboard.body.startsWith(DASHBOARD_MARKER));
  assert.equal(first.dashboard.stateSaved, true);

  // 確認：PR 作者與權限不足的不算；write 以上的人確認後通過。
  const comments = [
    comment(1, '/reviewer ack F1-d00d@1111111 我自己確認', 'author'),
    comment(2, '/reviewer ack F1-d00d@1111111 看過了', 'reader'),
    comment(3, '/reviewer ack F1-d00d@1111111 已確認改由呼叫端包 transaction'),
    comment(4, '一般留言'),
    comment(5, '/reviewer ack F1-d00d@1111111 bot', 'reviewer[bot]', { user: { login: 'reviewer[bot]', type: 'Bot' } }),
  ];
  const second = step(head1, first.dashboard.body, comments);
  assert.equal(second.previousState.status, 'valid');
  assert.equal(stateOf(second, 'F1'), 'ACKNOWLEDGED');
  assert.equal(second.check.conclusion, 'success');
  assert.deepEqual(second.replies.map(({ commentId }) => commentId), [1, 2, 3]);
  assert.match(second.replies[0].body, /PR 作者不能確認/);
  assert.match(second.replies[1].body, /需要 write 以上/);
  assert.match(second.replies[2].body, /^✅ 已確認 F1-d00d/);
  assert.match(second.dashboard.body, /✅ 人工確認完成/);
  assert.match(second.dashboard.body, /alice 已確認/);

  // 已處理過的留言不會再回覆。
  const again = step(head1, second.dashboard.body, comments);
  assert.deepEqual(again.replies, []);
  assert.equal(stateOf(again, 'F1'), 'ACKNOWLEDGED');

  // 新的 head：上方插入程式碼（scope 不變）→ 仍是已確認。
  const moved = step(report(sha(2), { files: [{ ...head1.files[0], findings: [door({ location: { side: 'base', startLine: 50, endLine: 52 } })] }] }), again.dashboard.body, comments);
  assert.equal(stateOf(moved, 'F1'), 'ACKNOWLEDGED');

  // 同一個 method 又改了（scope 改變）→ 重新開啟，Check 失敗。
  const changedReport = report(sha(3), { files: [{ ...head1.files[0], findings: [door({ scopeHash: 'php:scope-2' })] }] });
  const changed = step(changedReport, moved.dashboard.body, comments);
  assert.equal(stateOf(changed, 'F1'), 'REOPENED');
  assert.equal(changed.items[0].reopenedBecause, 'CODE_CHANGED');
  assert.equal(changed.check.conclusion, 'failure');
  assert.match(changed.dashboard.body, /重新開啟（確認後程式碼又改了）/);

  // 以舊的 head 確認：被拒絕（看完之後又改了）；以目前的 head 確認才通過。
  const reAck = [...comments, comment(6, '/reviewer ack F1-d00d@1111111 再看一次'), comment(7, '/reviewer ack F1-d00d@3333333 看過新的版本', 'bob')];
  const reAcked = step(changedReport, changed.dashboard.body, reAck);
  assert.match(reAcked.replies[0].body, /又改了/);
  assert.match(reAcked.replies[1].body, /^✅/);
  assert.equal(stateOf(reAcked, 'F1'), 'ACKNOWLEDGED');

  // 修正（finding 消失）→ 已修正；Check 通過。
  const fixed = step(report(sha(4), { files: report(sha(4)).files.slice(1) }), reAcked.dashboard.body, reAck);
  assert.equal(stateOf(fixed, 'F1'), 'FIXED');
  assert.equal(fixed.check.conclusion, 'success');
  assert.match(fixed.dashboard.body, /🟢 不需要人工確認/);
  assert.match(fixed.dashboard.body, /已修正 1/);

  // 修正後再次出現（scope 與之前確認的不同）→ 重新開啟。
  const back = step(report(sha(5), { files: [{ ...head1.files[0], findings: [door({ scopeHash: 'php:scope-9' })] }] }), fixed.dashboard.body, reAck);
  assert.equal(stateOf(back, 'F1'), 'REOPENED');
  // 狀態持續保留重新開啟的原因。
  const stillBack = step(report(sha(5), { files: [{ ...head1.files[0], findings: [door({ scopeHash: 'php:scope-9' })] }] }), back.dashboard.body, reAck);
  assert.equal(stateOf(stillBack, 'F1'), 'REOPENED');
});

test('確認的指令留言之後被編輯、刪除或作者不符時，確認不再採用', () => {
  const first = step(report(sha(1)), null);
  const original = comment(3, '/reviewer ack F1-d00d@1111111 已確認');
  const acked = step(report(sha(1)), first.dashboard.body, [original]);
  assert.equal(stateOf(acked, 'F1'), 'ACKNOWLEDGED');
  // 留言不變：仍是已確認，沒有說明。
  const same = step(report(sha(1)), acked.dashboard.body, [original]);
  assert.equal(stateOf(same, 'F1'), 'ACKNOWLEDGED');
  assert.deepEqual(same.notes, []);

  for (const [label, comments] of [
    ['編輯過', [{ ...original, body: '算了，還沒看完', updated_at: 't9' }]],
    ['刪除', []],
    ['作者不符', [{ ...original, user: { login: 'mallory', type: 'User' } }]],
    ['變成 bot', [{ ...original, user: { login: 'alice[bot]', type: 'Bot' } }]],
  ]) {
    const result = step(report(sha(1)), acked.dashboard.body, comments);
    assert.equal(stateOf(result, 'F1'), 'OPEN', label);
    assert.equal(result.check.conclusion, 'failure', label);
    assert.deepEqual(result.notes, [{ code: 'ACKS_WITHDRAWN', count: 1 }], label);
    assert.match(result.dashboard.body, /1 個確認不再採用：指令留言被刪除或編輯/, label);
    // 下一次執行：確認已從狀態移除，不再重複說明。
    assert.deepEqual(step(report(sha(1)), result.dashboard.body, comments).notes, [], label);
  }
});

test('修正後再次出現、從未確認過的項目也是重新開啟', () => {
  const first = step(report(sha(1)), null);
  const fixed = step(report(sha(2), { files: report(sha(2)).files.slice(1) }), first.dashboard.body);
  const back = step(report(sha(3)), fixed.dashboard.body);
  assert.equal(stateOf(back, 'F1'), 'REOPENED');
  assert.equal(back.items[0].reopenedBecause, 'REAPPEARED');
  assert.match(back.dashboard.body, /修正後再次出現/);
});

test('規則更新（policy digest 改變）時確認失效', () => {
  const first = step(report(sha(1)), null);
  const acked = step(report(sha(1)), first.dashboard.body, [comment(1, '/reviewer ack F1-d00d@1111111 ok')]);
  const upgraded = step(report(sha(2), { files: [{ ...report(sha(2)).files[0], findings: [door({ policyDigest: 'policy-2' })] }] }), acked.dashboard.body, [comment(1, '/reviewer ack F1-d00d@1111111 ok')]);
  assert.equal(stateOf(upgraded, 'F1'), 'REOPENED');
  assert.equal(upgraded.items[0].reopenedBecause, 'POLICY_CHANGED');
  assert.match(upgraded.dashboard.body, /確認後規則已更新/);
  // 以舊的 head 確認：規則已更新，被拒絕。
  const retry = step(report(sha(2), { files: [{ ...report(sha(2)).files[0], findings: [door({ policyDigest: 'policy-2' })] }] }), upgraded.dashboard.body,
    [comment(1, '/reviewer ack F1-d00d@1111111 ok'), comment(2, '/reviewer ack F1-d00d@1111111 again')]);
  assert.match(retry.replies[0].body, /規則已更新/);
});

test('短編號：沿用、依序配發、永不重用；新的項目依路徑與行號排序', () => {
  const two = (head, findings) => report(head, { files: [{ ...report(head).files[0], findings }] });
  const first = step(two(sha(1), [door({ id: LOCK, blocker: 'ROW_LOCK_REMOVED', location: { side: 'head', startLine: 80, endLine: 80 } }), door()]), null);
  assert.deepEqual(first.items.map(({ label }) => label), ['F1-d00d', 'F2-b10c']);
  // F1 修正後，新出現的項目拿 F3（不重用 F1）。
  const third = 'c0de'.padEnd(64, 'c');
  const next = step(two(sha(2), [door({ id: LOCK, blocker: 'ROW_LOCK_REMOVED' }), door({ id: third, blocker: 'GUARD_CLAUSE_REMOVED' })]), first.dashboard.body);
  assert.deepEqual(next.items.map(({ label, state }) => [label, state]).sort(), [['F1-d00d', 'FIXED'], ['F2-b10c', 'OPEN'], ['F3-c0de', 'OPEN']]);
});

test('檔案層級的確認：AI 的疑慮在重跑時改變不影響；檔案內容改變時重新開啟', () => {
  const aiReport = (head, contentHash, title) => report(head, {
    files: [{ path: 'src/a.ts', track: 'AI_TRACK', contentHash, needsHuman: true, ai: {}, findings: [aiFinding('AI_CONCERN', title)] }],
  });
  const first = step(aiReport(sha(1), 'git:a1', 'AI：少了 null 檢查'), null);
  const label = first.items[0].label;
  assert.match(first.dashboard.body, /🤖 AI 提出疑慮/);
  const comments = [comment(1, `/reviewer ack ${label}@1111111 已確認 null 不會出現`)];
  const acked = step(aiReport(sha(1), 'git:a1', 'AI：少了 null 檢查'), first.dashboard.body, comments);
  assert.equal(acked.items[0].state, 'ACKNOWLEDGED');
  // 另一個 commit 沒有改這個檔案，AI 重跑後疑慮的標題不同：同一個檔案、同樣的內容，仍是已確認。
  const rerun = step(aiReport(sha(2), 'git:a1', 'AI：參數可能為空'), acked.dashboard.body, comments);
  assert.equal(rerun.items[0].state, 'ACKNOWLEDGED');
  // 檔案內容改變：重新開啟。
  const edited = step(aiReport(sha(3), 'git:a2', 'AI：參數可能為空'), rerun.dashboard.body, comments);
  assert.equal(edited.items[0].state, 'REOPENED');
  // 檔案層級的項目沒有行內 thread。
  assert.deepEqual(edited.threads, []);
});

test('狀態無法驗證時從頭重播確認：可以從之前的報表驗證的保留，不行的需要重新確認；不逐則回覆', () => {
  const head1 = report(sha(1));
  const head2 = report(sha(2), { files: [{ ...head1.files[0], findings: [door({ location: { side: 'base', startLine: 60, endLine: 60 } })] }] });
  const first = step(head1, null);
  const comments = [comment(1, '/reviewer ack F1-d00d@1111111 看過了')];
  const acked = step(head1, first.dashboard.body, comments);
  // 有人編輯了儀表板留言（簽章不符）。
  const tampered = acked.dashboard.body.replace(/sig=[0-9a-f]{64}/, `sig=${'0'.repeat(64)}`);

  const withoutHistory = step(head2, tampered, comments);
  assert.equal(withoutHistory.previousState.reason, 'STATE_SIGNATURE_MISMATCH');
  assert.equal(stateOf(withoutHistory, 'F1'), 'OPEN');
  assert.deepEqual(withoutHistory.replies, []);
  assert.deepEqual(withoutHistory.notes, [{ code: 'STATE_RESET', reason: 'STATE_SIGNATURE_MISMATCH', replayed: 1, rejected: 1 }]);
  assert.match(withoutHistory.dashboard.body, /先前的狀態無法驗證/);

  const withHistory = step(head2, tampered, comments, { history: [head1] });
  assert.equal(stateOf(withHistory, 'F1'), 'ACKNOWLEDGED');
  assert.deepEqual(withHistory.notes, [{ code: 'STATE_RESET', reason: 'STATE_SIGNATURE_MISMATCH', replayed: 1, rejected: 0 }]);
  // 重算之後的狀態是新簽的，下次就是合法狀態。
  assert.equal(step(head2, withHistory.dashboard.body, comments).previousState.status, 'valid');
});

test('換 key：舊的 key 仍可驗證狀態，寫出時改用新的 key', () => {
  const first = step(report(sha(1)), null);
  const rotated = stateKeys('new-key', 'test-key');
  const next = step(report(sha(1)), first.dashboard.body, [], { keys: rotated });
  assert.equal(next.previousState.status, 'valid');
  assert.ok(next.dashboard.body.includes(`kid=${rotated.current.id}`));
  // 沒有任何 key 時：狀態不簽章，下次不會被採用。
  const unsigned = step(report(sha(1)), null, [], { keys: stateKeys(null) });
  assert.equal(unsigned.dashboard.signed, false);
  assert.equal(step(report(sha(1)), unsigned.dashboard.body).previousState.reason, 'STATE_UNSIGNED');
});

test('同一個人重複確認同一個版本只記一次；格式錯誤的指令回覆正確格式', () => {
  const comments = [
    comment(1, '/reviewer ack F1-d00d@1111111 第一次\n/reviewer ack F1-d00d@1111111 第二次\n/reviewer ack F1@1111111 少了 id'),
  ];
  const result = computeState({ report: report(sha(1)), previous: { status: 'absent' }, comments, pr: { number: 42, login: 'author' }, permissions });
  assert.equal(result.state.acks.length, 1);
  assert.equal(result.state.lastProcessedCommentId, 1);
  assert.equal(result.replies.length, 1);
  assert.deepEqual(result.replies[0].body.split('\n').map((line) => line.slice(0, 6)), ['✅ 已確認 ', '✅ 已確認 ', '⚠️ 指令格']);
  // 沒有留言時 lastProcessedCommentId 維持 null；沒有整數 id 的留言忽略。
  const empty = computeState({ report: report(sha(1)), previous: { status: 'absent' }, comments: [{ id: 'x', body: '/reviewer ack F1-d00d@1111111 x' }], pr: { number: 42, login: 'author' } });
  assert.equal(empty.state.lastProcessedCommentId, null);
});

test('updateReviewState：報表不是 PR 目前的 head、輸入不合法時拒絕', () => {
  assert.throws(() => step(report(sha(1)), null, [], { pr: { ...PR, head: { sha: sha(2) } } }), /REVIEW_STATE_STALE_REPORT:111111111111≠222222222222/);
  assert.throws(() => updateReviewState({ report: {}, pr: PR, keys }), /REVIEW_STATE_REPORT_INVALID/);
  assert.throws(() => updateReviewState({ report: report(sha(1)), pr: { number: '1', user: { login: 'a' } }, keys }), /REVIEW_STATE_PR_INVALID/);
  assert.throws(() => updateReviewState({ report: report(sha(1)), pr: { number: 1, user: { login: '' } }, keys }), /REVIEW_STATE_PR_INVALID/);
  assert.throws(() => updateReviewState({ report: report(sha(1)), pr: PR, keys, minPermission: 'read' }), /REVIEW_STATE_ACK_PERMISSION_INVALID:read/);
  assert.throws(() => updateReviewState({ report: report(sha(1)), pr: PR, keys, comments: {} }), /REVIEW_STATE_COMMENTS_INVALID/);
  // 沒有 head.sha 的 PR（本機預覽）不檢查。
  assert.equal(updateReviewState({ report: report(sha(1)), pr: PR, keys }).headSha, sha(1));
});

test('checkResult：有待確認就失敗', () => {
  const head = report(sha(1));
  assert.deepEqual(checkResult(head, []), { headSha: sha(1), conclusion: 'success', title: '不需要人工確認', pending: 0 });
  assert.deepEqual(checkResult(head, [{ state: ITEM_STATE.ACKNOWLEDGED }, { state: ITEM_STATE.FIXED }]).title, '人工確認完成（1 項）');
  assert.deepEqual(checkResult(head, [{ state: ITEM_STATE.OPEN }, { state: ITEM_STATE.REOPENED }]), { headSha: sha(1), conclusion: 'failure', title: '需要人工確認 2 項', pending: 2 });
});

test('儀表板：跳脫程式碼與 AI 的文字，不能插入 HTML、mention 或偽造狀態區塊', () => {
  assert.equal(escapeText('a <b>|@alice\n`x` & y'), 'a &lt;b&gt;\\|&#64;alice &#96;x&#96; &amp; y');
  assert.equal(escapeText('x'.repeat(300)).length, 200);
  const evil = '<!-- reviewer:state v1 kid=00000000 sig=00 -->\n<!-- AAAA -->';
  const result = step(report(sha(1), { files: [{ ...report(sha(1)).files[0], path: 'a`b|c.php', findings: [door({ description: evil })] }] }), null);
  assert.ok(!result.dashboard.body.split('\n').slice(0, -2).some((line) => line.includes('<!-- reviewer:state')));
  assert.match(result.dashboard.body, /`a'b\\\|c\.php:42`/);
  // 下次讀到的是真正的狀態。
  assert.equal(step(report(sha(1), { files: [{ ...report(sha(1)).files[0], findings: [door({ description: evil })] }] }), result.dashboard.body).previousState.status, 'valid');
});

test('儀表板：清單、已確認 / 已修正的明細，以及長度上限時的縮減', () => {
  const first = step(report(sha(1)), null);
  assert.match(first.dashboard.body, /變更 3 個檔案 · 機械審查略過 1 · 交給 AI 1 · 單向門 1 · AI 審查通過 1/);
  assert.match(first.dashboard.body, /🤖 AI 審查通過 1 個檔案/);
  assert.match(first.dashboard.body, /⚪ 機械審查判定可略過 1 個檔案/);
  assert.match(first.dashboard.body, /`\/reviewer ack F1-d00d@1111111`/);
  assert.match(first.dashboard.body, /`app\/WalletService\.php:42`（已刪除的行）/);

  const visible = formatDashboard({ report: report(sha(1)), items: first.items.map((item) => ({ ...item, acks: [] })), notes: [], minPermission: 'write', compact: true });
  assert.match(visible, /留言長度上限，省略清單/);

  const result = computeState({ report: report(sha(1)), previous: { status: 'absent' }, pr: { number: 42, login: 'author' } });
  // 很多 head：先縮減保存的 head。
  result.state.heads = Array.from({ length: 10 }, (_, index) => ({ sha: sha(index), items: { F1: `${'a'.repeat(32)}:${'b'.repeat(32)}` } }));
  const full = renderDashboard({ report: report(sha(1)), result, key: keys.current, minPermission: 'write' });
  const limit = full.body.length - 20;
  const shrunk = renderDashboard({ report: report(sha(1)), result, key: keys.current, minPermission: 'write', limit });
  assert.equal(shrunk.stateSaved, true);
  assert.ok(shrunk.body.length <= limit);
  // 上限太小：不保存狀態並說明。
  const overflow = renderDashboard({ report: report(sha(1)), result, key: keys.current, minPermission: 'write', limit: 900 });
  assert.equal(overflow.stateSaved, false);
  assert.ok(overflow.body.length <= 900);
  assert.ok(!overflow.body.includes('reviewer:state'));
  const tiny = renderDashboard({ report: report(sha(1)), result, key: keys.current, minPermission: 'write', limit: 50 });
  assert.equal(tiny.body.length, 50);
  // 下次執行：有儀表板但沒有狀態，視為無法驗證（重播、不逐則回覆）。
  const next = step(report(sha(1)), overflow.body, [comment(1, '/reviewer ack F1-d00d@1111111 舊的確認')]);
  assert.equal(next.previousState.reason, 'STATE_MISSING');
  assert.deepEqual(next.replies, []);
  // 沒有儀表板標記的文字仍是第一次執行。
  assert.equal(step(report(sha(1)), '別的留言').previousState.status, 'absent');
});

test('threadTargets：只為單向門；待確認為 open，已確認與已修正為 resolved；內容帶 finding 標記', () => {
  const first = step(report(sha(1)), null);
  const [thread] = first.threads;
  assert.deepEqual({ ...thread, body: undefined }, {
    findingId: DOOR,
    label: 'F1-d00d',
    state: 'open',
    location: { path: 'app/WalletService.php', side: 'LEFT', startLine: 42, line: 44 },
    body: undefined,
  });
  assert.match(thread.body, /<!-- reviewer:finding d00d/);
  assert.match(thread.body, /\/reviewer ack F1-d00d@1111111 <理由>/);

  const fixed = step(report(sha(2), { files: report(sha(2)).files.slice(1) }), first.dashboard.body);
  assert.deepEqual(fixed.threads.map(({ state, location }) => [state, location]), [['resolved', null]]);
  const head = threadTargets(report(sha(1)), [{ ...first.items[0], kind: 'DOOR', state: 'OPEN', location: { side: 'head', startLine: 3 }, path: 'x', acks: [] }]);
  assert.deepEqual(head[0].location, { path: 'x', side: 'RIGHT', startLine: 3, line: 3 });
  assert.equal(itemLabel({ shortId: 'F7', id: 'abcdef' }), 'F7-abcd');
});
