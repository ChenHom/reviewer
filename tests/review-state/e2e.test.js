import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { reviewRange } from '../../src/review/review.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../bin/review-state.js', import.meta.url));
const repo = await mkdtemp(join(tmpdir(), 'review-state-repo-'));
const work = await mkdtemp(join(tmpdir(), 'review-state-io-'));
after(() => Promise.all([rm(repo, { recursive: true, force: true }), rm(work, { recursive: true, force: true })]));

const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
const service = (refund, extra = '') => `<?php\n\nclass OrderService\n{\n${extra}    public function refund($order)\n    {\n${refund}\n    }\n}\n`;
const commit = async (content, message) => {
  await writeFile(join(repo, 'OrderService.php'), content);
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
  return (await git('rev-parse', 'HEAD')).stdout.trim();
};
/** bot 建立、沒有被編輯過的儀表板留言（GitHub REST 的 comment 加上 GraphQL 的 editor）。 */
const dashboardComment = (body) => ({ id: 1, body, user: { login: 'reviewer[bot]', type: 'Bot' }, editor: null });
const json = async (name, value) => {
  const path = join(work, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

/**
 * 執行 CLI，回傳 exit code、stdout 與 stderr（非 0 也不丟例外）。
 *
 * @param {string[]} args - 參數。
 * @param {object} [env] - 額外的環境變數。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 結果。
 */
async function cli(args, env = { REVIEWER_STATE_KEY: 'e2e-key' }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('端對端：真實報表 → 待確認 → 確認 → 上方插入程式碼仍有效 → 同一個 method 改變後重新開啟', async () => {
  await git('init', '-q');
  const base = await commit(service("        $this->authorize('refund', $order);\n        return $order->refund($order->amount);"), 'base');
  const head1 = await commit(service('        return $order->refund($order->amount);'), 'remove authorize');
  const report1 = await reviewRange({ repo, base, head: head1 });
  const [finding] = report1.files[0].findings;
  assert.equal(finding.blocker, 'AUTHORIZATION_GUARD_REMOVED');

  const pr = (head) => ({ number: 7, user: { login: 'author' }, head: { sha: head } });
  const files = {
    report: await json('report1.json', report1),
    pr: await json('pr1.json', pr(head1)),
    permissions: await json('permissions.json', { alice: 'write' }),
  };

  // 第一次：待確認，--fail-on-pending 時 exit 1。
  const first = await cli(['--report', files.report, '--pr', files.pr, '--out', join(work, 'out1.json'), '--fail-on-pending']);
  assert.equal(first.code, 1, first.stderr);
  const out1 = JSON.parse(await readFile(join(work, 'out1.json'), 'utf8'));
  const byKind = (out, kind) => out.items.find((item) => item.kind === kind);
  // 沒有 AI 審查：單向門之外，整個檔案也要人工確認。
  assert.deepEqual(out1.items.map(({ kind, blocker }) => [kind, blocker]), [['DOOR', 'AUTHORIZATION_GUARD_REMOVED'], ['FILE', 'AI_REVIEW_MISSING']]);
  const label = byKind(out1, 'DOOR').label;
  const fileLabel = byKind(out1, 'FILE').label;
  assert.match(label, new RegExp(`^F1-${finding.id.slice(0, 4)}$`));
  assert.equal(out1.check.conclusion, 'failure');
  assert.equal(out1.dashboard.body, first.stdout.trimEnd());
  assert.match(first.stdout, new RegExp(`/reviewer ack ${label}@${head1.slice(0, 7)}`));

  // 確認（儀表板以 GitHub comment JSON 傳入，含作者與編輯者）。
  const comments = [
    { id: 100, body: `/reviewer ack ${label}@${head1.slice(0, 7)} 呼叫端已檢查權限`, user: { login: 'alice', type: 'User' }, created_at: 't', updated_at: 't' },
    { id: 101, body: `/reviewer ack ${fileLabel}@${head1.slice(0, 7)} 整個檔案看過了`, user: { login: 'alice', type: 'User' }, created_at: 't', updated_at: 't' },
  ];
  const second = await cli([
    '--report', files.report, '--pr', files.pr, '--permissions', files.permissions,
    '--dashboard', await json('dashboard1.json', dashboardComment(out1.dashboard.body)),
    '--comments', await json('comments.json', comments), '--json', '--fail-on-pending',
  ]);
  assert.equal(second.code, 0, second.stderr);
  const out2 = JSON.parse(second.stdout);
  assert.deepEqual(out2.items.map(({ state }) => state), ['ACKNOWLEDGED', 'ACKNOWLEDGED']);
  assert.match(out2.replies[0].body, /^✅/);
  assert.match(out2.replies[1].body, /^✅/);

  // 上方插入另一個 method：單向門的 finding 與 scope 不變，確認仍有效；檔案層級的確認綁定檔案內容，重新開啟。
  const head2 = await commit(service('        return $order->refund($order->amount);', '    public function audit($order)\n    {\n        return $order->id;\n    }\n\n'), 'insert above');
  const third = await cli([
    '--report', await json('report2.json', await reviewRange({ repo, base, head: head2 })), '--pr', await json('pr2.json', pr(head2)),
    '--permissions', files.permissions, '--dashboard', await json('dashboard2.json', dashboardComment(out2.dashboard.body)), '--comments', await json('comments.json', comments), '--json',
  ]);
  const out3 = JSON.parse(third.stdout);
  assert.equal(byKind(out3, 'DOOR').state, 'ACKNOWLEDGED');
  assert.equal(byKind(out3, 'DOOR').label, label);
  assert.equal(byKind(out3, 'FILE').state, 'REOPENED');

  // 同一個 method 的邏輯改變：重新開啟。
  const head3 = await commit(service('        return $order->refund($order->amount - 1);', '    public function audit($order)\n    {\n        return $order->id;\n    }\n\n'), 'change logic');
  const fourth = await cli([
    '--report', await json('report3.json', await reviewRange({ repo, base, head: head3 })), '--pr', await json('pr3.json', pr(head3)),
    '--permissions', files.permissions, '--dashboard', await json('dashboard3.json', dashboardComment(out3.dashboard.body)), '--comments', await json('comments.json', comments), '--json',
  ]);
  const out4 = JSON.parse(fourth.stdout);
  assert.deepEqual(byKind(out4, 'DOOR'), { ...byKind(out3, 'DOOR'), state: 'REOPENED', reopenedBecause: 'CODE_CHANGED', location: byKind(out4, 'DOOR').location });
  assert.equal(out4.check.conclusion, 'failure');

  // 狀態被竄改時，以之前的報表（--history）驗證確認。
  await mkdir(join(work, 'history'), { recursive: true });
  await writeFile(join(work, 'history', 'report1.json'), JSON.stringify(report1));
  const tampered = out2.dashboard.body.replace(/sig=[0-9a-f]{64}/, `sig=${'f'.repeat(64)}`);
  const replay = await cli([
    '--report', files.report, '--pr', files.pr, '--permissions', files.permissions, '--dashboard', await json('tampered.json', dashboardComment(tampered)),
    '--comments', await json('comments.json', comments), '--history', join(work, 'history'), '--json',
  ]);
  const replayed = JSON.parse(replay.stdout);
  assert.equal(replayed.previousState.reason, 'STATE_SIGNATURE_MISMATCH');
  assert.deepEqual(replayed.items.map(({ state }) => state), ['ACKNOWLEDGED', 'ACKNOWLEDGED']);
  assert.deepEqual(replayed.replies, []);

  // 只有儀表板的內容（不知道作者與編輯者）：不採用保存的狀態，從確認留言重播。
  const plain = await cli([
    '--report', files.report, '--pr', files.pr, '--permissions', files.permissions, '--dashboard', await json('dashboard-plain.md', out2.dashboard.body),
    '--comments', await json('comments.json', comments), '--json',
  ]);
  assert.equal(JSON.parse(plain.stdout).previousState.reason, 'STATE_EDITOR_UNKNOWN');
});

test('CLI：缺少選項、沒有 key、舊的報表與無效輸入時 exit 2', async () => {
  const report = { head: { sha: 'a'.repeat(40) }, config: { digest: null }, ai: null, files: [] };
  const reportPath = await json('cli-report.json', report);
  const prPath = await json('cli-pr.json', { number: 1, user: { login: 'author' }, head: { sha: 'a'.repeat(40) } });

  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /用法：reviewer state/);

  for (const [args, pattern] of [
    [['--pr', prPath], /OPTION_MISSING:--report/],
    [['--report', reportPath], /OPTION_MISSING:--pr/],
    [['--report', reportPath, '--pr', prPath, '--ack-permission', 'read'], /OPTION_INVALID:--ack-permission=read/],
    [['--report', join(work, 'missing.json'), '--pr', prPath], /REVIEW_STATE_REPORT_NOT_JSON/],
    [['--report', reportPath, '--pr', await json('stale-pr.json', { number: 1, user: { login: 'author' }, head: { sha: 'b'.repeat(40) } })], /REVIEW_STATE_STALE_REPORT/],
    [['--report', reportPath, '--pr', prPath, '--comments', await json('bad-comments.json', '{')], /REVIEW_STATE_COMMENTS_NOT_JSON/],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, pattern);
  }

  const noKey = await cli(['--report', reportPath, '--pr', prPath], {});
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /REVIEW_STATE_KEY_MISSING/);

  // --unsigned：本機預覽，狀態不簽章並警告。儀表板檔案不是 JSON 時當成純文字。
  const preview = await cli(['--report', reportPath, '--pr', prPath, '--unsigned', '--dashboard', await json('plain.md', '{ 不是 JSON')], {});
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /🟢 不需要人工確認/);
  assert.match(preview.stdout, /kid=unsigned/);
  assert.match(preview.stderr, /沒有簽章/);

  // 歷史報表中無法解析的檔案只警告。
  const history = await cli(['--report', reportPath, '--pr', prPath, '--history', await json('broken-history.json', 'nope')]);
  assert.equal(history.code, 0);
  assert.match(history.stderr, /REPORT_NOT_JSON/);
});
