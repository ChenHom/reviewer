import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { reviewRange } from '../../src/review/review.js';

const run = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), 'review-findings-'));
after(() => rm(repo, { recursive: true, force: true }));

const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
const service = (refund, extra = '') => `<?php\n\nclass OrderService\n{\n${extra}    public function refund($order)\n    {\n${refund}\n    }\n}\n`;

const commit = async (content, message) => {
  await writeFile(join(repo, 'OrderService.php'), content);
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
  return (await git('rev-parse', 'HEAD')).stdout.trim();
};

const findingsAt = async (base, head) => {
  const report = await reviewRange({ repo, base, head });
  // 回到與 base 相同的內容時檔案不在 diff 中，也就沒有 finding。
  return report.files[0]?.findings ?? [];
};

test('二次 review：finding id 在上方插入程式碼後不變；scope hash 只在同一個 method 的邏輯改變時改變', async () => {
  await git('init', '-q');
  const base = await commit(service("        $this->authorize('refund', $order);\n        $total = $order->amount;\n        return $order->refund($total);"), 'base');

  const first = await commit(service('        $total = $order->amount;\n        return $order->refund($total);'), 'remove authorize');
  const [initial] = await findingsAt(base, first);
  assert.equal(initial.blocker, 'AUTHORIZATION_GUARD_REMOVED');
  assert.equal(initial.subject, 'OrderService::refund');
  assert.match(initial.scopeHash, /^php:/);

  // 上方插入另一個 method 與註解：行號改變，finding 與 scope 不變
  const inserted = await commit(service(
    '        // refund the full amount\n        $total = $order->amount;\n        return $order->refund($total);',
    '    public function audit($order)\n    {\n        return $order->id;\n    }\n\n',
  ), 'insert above');
  const [afterInsert] = await findingsAt(base, inserted);
  assert.equal(afterInsert.id, initial.id);
  assert.equal(afterInsert.scopeHash, initial.scopeHash);
  assert.notEqual(afterInsert.location.startLine, undefined);

  // 區域變數改名：scope 不變
  const renamed = await commit(service(
    '        // refund the full amount\n        $sum = $order->amount;\n        return $order->refund($sum);',
    '    public function audit($order)\n    {\n        return $order->id;\n    }\n\n',
  ), 'rename local');
  assert.equal((await findingsAt(base, renamed))[0].scopeHash, initial.scopeHash);

  // 同一個 method 的邏輯改變：同一個 finding，scope 改變（人工豁免會失效）
  const changed = await commit(service(
    '        $sum = $order->amount - 1;\n        return $order->refund($sum);',
    '    public function audit($order)\n    {\n        return $order->id;\n    }\n\n',
  ), 'change logic');
  const [afterChange] = await findingsAt(base, changed);
  assert.equal(afterChange.id, initial.id);
  assert.notEqual(afterChange.scopeHash, initial.scopeHash);

  // 加回 authorize：finding 消失（已修正）
  const fixed = await commit(service("        $this->authorize('refund', $order);\n        $total = $order->amount;\n        return $order->refund($total);"), 'fix');
  assert.deepEqual(await findingsAt(base, fixed), []);
});

test('同一個 method 中兩個相同的移除產生兩個不同的 finding', async () => {
  const twice = service("        $this->authorize('refund', $order);\n        $order->lock();\n        $this->authorize('refund', $order);\n        return $order->refund();");
  const base = await commit(twice, 'twice');
  const head = await commit(service('        $order->lock();\n        return $order->refund();'), 'remove both');
  const findings = await findingsAt(base, head);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(({ ordinal }) => ordinal), [0, 1]);
  assert.notEqual(findings[0].id, findings[1].id);
});
