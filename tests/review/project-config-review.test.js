import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { formatReview } from '../../src/review/format.js';
import { reviewRange } from '../../src/review/review.js';

const run = promisify(execFile);
const roots = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const php = (body) => `<?php\n\nclass Service\n{\n    public function run($q)\n    {\n${body}\n    }\n}\n`;

/**
 * 建立有 base / head 兩個 commit 的 repository。
 *
 * @param {object} baseFiles - base 的檔案（path → 內容；內容為 `{ symlink }` 時建立 symlink）。
 * @param {object} headFiles - head 要寫入的檔案。
 * @returns {Promise<{repo: string, base: string, head: string}>} repository 與 commit。
 */
async function repository(baseFiles, headFiles) {
  const repo = await mkdtemp(join(tmpdir(), 'review-config-'));
  roots.push(repo);
  const git = (...args) => run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
  const put = async (files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(repo, path, '..'), { recursive: true });
      if (typeof content === 'object') await symlink(content.symlink, join(repo, path));
      else await writeFile(join(repo, path), content);
    }
    await git('add', '-A');
  };
  await git('init', '-q');
  await put(baseFiles);
  await git('commit', '-q', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await put(headFiles);
  await git('commit', '-q', '-m', 'head');
  return { repo, base, head: (await git('rev-parse', 'HEAD')).stdout.trim() };
}

const config = {
  version: 1,
  rules: {
    sensitiveOperands: [{ pattern: '/amount/', operators: 'comparison' }],
    protectedPaths: ['database/migrations/**'],
  },
  routing: { aiTrackPaths: ['docs/**'] },
};

test('專案設定從 merge base 讀取：敏感運算元、受保護路徑、AI 路徑與修改設定本身', async () => {
  const { repo, base, head } = await repository({
    '.reviewer.json': JSON.stringify(config),
    'src/Op.php': php('        return $q->amount < 10;'),
    'database/migrations/Create.php': php('        return 1;'),
    'docs/guide.md': '# guide\n',
  }, {
    // PR 同時拿掉規則：本次 review 仍使用 merge base 的設定。
    '.reviewer.json': JSON.stringify({ version: 1 }),
    'src/Op.php': php('        return $q->amount <= 10;'),
    'database/migrations/Create.php': php('        // formatting only\n        return 1;'),
    'docs/guide.md': '# guide\n\nmore\n',
  });

  const report = await reviewRange({ repo, base, head });
  const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));

  assert.equal(report.config.status, 'valid');
  assert.equal(report.config.commit, base);
  assert.match(report.config.digest, /^[0-9a-f]{64}$/);

  assert.deepEqual(byPath['src/Op.php'].reasons, ['COMPARISON_OPERATOR_CHANGED', 'SENSITIVE_OPERAND_CHANGED']);
  assert.equal(byPath['src/Op.php'].track, 'ESCALATED');

  // 只有排版變更的 migration 原本不需 review，受保護路徑讓它需要人工確認。
  const migration = byPath['database/migrations/Create.php'];
  assert.equal(migration.decision, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(migration.fallback, 'TARGETED');
  assert.deepEqual(migration.reasons, ['PROTECTED_PATH']);
  assert.equal(migration.track, 'ESCALATED');
  assert.ok(migration.changedLines.length > 0);

  assert.deepEqual(byPath['docs/guide.md'].reasons, ['UNSUPPORTED_FILE_TYPE']);
  assert.equal(byPath['docs/guide.md'].track, 'AI_TRACK');

  assert.deepEqual(byPath['.reviewer.json'].reasons, ['UNSUPPORTED_FILE_TYPE', 'POLICY_FILE_CHANGED']);
  assert.equal(byPath['.reviewer.json'].track, 'ESCALATED');

  assert.match(formatReview(report), /PROTECTED_PATH（單向門）/);
});

test('設定無效時每個檔案都是 FULL + POLICY_CONFIG_INVALID', async () => {
  const { repo, base, head } = await repository({
    '.reviewer.json': JSON.stringify({ version: 1, rules: { ignoreFacts: ['X'] } }),
    'src/Format.php': php('        return 1;'),
  }, {
    'src/Format.php': php('        return   1;'),
  });

  const report = await reviewRange({ repo, base, head });
  assert.equal(report.config.status, 'invalid');
  assert.deepEqual(report.config.errors, ['POLICY_CONFIG_KEY_UNKNOWN:rules.ignoreFacts']);
  assert.deepEqual(report.files.map(({ decision, fallback, reasons, track }) => ({ decision, fallback, reasons, track })), [
    { decision: 'HUMAN_REVIEW_REQUIRED', fallback: 'FULL', reasons: ['POLICY_CONFIG_INVALID'], track: 'ESCALATED' },
  ]);
});

test('沒有設定時使用預設值；設定是 symlink 時視為無效', async () => {
  const absent = await repository({ 'src/A.php': php('        return 1;') }, { 'src/A.php': php('        return 2;') });
  const report = await reviewRange(absent);
  assert.deepEqual(report.config, { path: '.reviewer.json', commit: absent.base, status: 'absent', errors: [], digest: null });

  const linked = await repository({
    'other.json': JSON.stringify({ version: 1 }),
    '.reviewer.json': { symlink: 'other.json' },
    'src/A.php': php('        return 1;'),
  }, { 'src/A.php': php('        return 2;') });
  const linkedReport = await reviewRange(linked);
  assert.equal(linkedReport.config.status, 'invalid');
  assert.deepEqual(linkedReport.config.errors, ['POLICY_CONFIG_NOT_REGULAR_FILE']);
});
