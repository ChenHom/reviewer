import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../../src/summary.js';
import { runAnalysis } from '../../src/runner.js';
import {
  GITHUB_PUBLICATION_FAILED,
  publishGithubResult,
} from '../../src/integrations/github/publisher.js';
import { validateGithubPayload } from '../../src/integrations/github/contracts.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-github-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

const input = {
  identity,
  coverage: {
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{
        path: 'src/example.js',
        startByte: 0,
        endByte: 10,
        language: 'javascript',
        adapterId: 'javascript-v1',
        runtime: 'server',
      }],
    }],
  },
  riskBlockers: [],
};

function payload(overrides = {}) {
  const candidate = runAnalysis(input);
  const summary = buildSummary(candidate);
  return {
    repository: identity.repository,
    headSha: identity.headSha,
    candidateDigest: summary.candidateDigest,
    summary,
    check: {
      state: 'PASS',
      reason: 'CURRENT_AUTHORITATIVE_SUMMARY',
    },
    ...overrides,
  };
}

function transport({ summaryResponse = { ok: true, status: 200, id: 'summary-1' }, checkResponse = { ok: true, status: 201, id: 'check-1' } } = {}) {
  const calls = [];
  return {
    calls,
    async upsertSummary(request) {
      calls.push({ type: 'summary', request });
      return summaryResponse;
    },
    async upsertCheck(request) {
      calls.push({ type: 'check', request });
      return checkResponse;
    },
  };
}

test('valid payload 會以固定 marker、head SHA 與 candidate digest 發布 Summary/check', async () => {
  const fake = transport();
  const result = await publishGithubResult(fake, payload());

  assert.equal(result.published, true);
  assert.deepEqual(result.receipt, {
    summary: { ok: true, status: 200, id: 'summary-1' },
    check: { ok: true, status: 201, id: 'check-1' },
  });
  assert.deepEqual(fake.calls.map(({ type }) => type), ['summary', 'check']);
  assert.equal(fake.calls[0].request.marker, 'REVIEW_REDUCTION_SAFETY');
  assert.equal(fake.calls[0].request.headSha, identity.headSha);
  assert.equal(fake.calls[0].request.candidateDigest, payload().candidateDigest);
});

test('Summary、head、digest 或 analysis failure/check 綁定錯誤時不呼叫 transport', async () => {
  const fake = transport();
  const invalid = payload({
    headSha: 'head-other',
    check: { state: 'PASS', reason: 'CURRENT_AUTHORITATIVE_SUMMARY' },
    summary: {
      ...payload().summary,
      analysisStatus: 'ANALYSIS_FAILED',
    },
  });

  assert.deepEqual(validateGithubPayload(invalid).valid, false);
  assert.deepEqual(await publishGithubResult(fake, invalid), {
    published: false,
    reason: GITHUB_PUBLICATION_FAILED,
  });
  assert.deepEqual(fake.calls, []);

  const missingIdentityField = payload({
    summary: {
      ...payload().summary,
      identity: { ...payload().summary.identity, policyVersion: undefined },
    },
  });
  assert.deepEqual(await publishGithubResult(fake, missingIdentityField), {
    published: false,
    reason: GITHUB_PUBLICATION_FAILED,
  });
});

test('non-2xx transport response 會回傳 delivery failure', async () => {
  const result = await publishGithubResult(
    transport({ summaryResponse: { ok: false, status: 500 } }),
    payload(),
  );

  assert.deepEqual(result, {
    published: false,
    reason: GITHUB_PUBLICATION_FAILED,
  });
});

test('transport timeout/exception 不暴露 exception 內容', async () => {
  const fake = {
    async upsertSummary() {
      throw new Error('secret github token');
    },
    async upsertCheck() {
      return { ok: true, status: 200, id: 'check-1' };
    },
  };
  const result = await publishGithubResult(fake, payload());

  assert.deepEqual(result, {
    published: false,
    reason: GITHUB_PUBLICATION_FAILED,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret github token|Error:|at /);
});

test('malformed response 與 same-head conflict 都不會被視為發布成功', async () => {
  const malformed = await publishGithubResult(
    transport({ summaryResponse: { ok: true, status: 200 } }),
    payload(),
  );
  const conflict = await publishGithubResult(
    transport({ summaryResponse: { ok: false, status: 409, id: 'conflict' } }),
    payload(),
  );

  assert.deepEqual(malformed, { published: false, reason: GITHUB_PUBLICATION_FAILED });
  assert.deepEqual(conflict, { published: false, reason: GITHUB_PUBLICATION_FAILED });
});

test('相同 head/digest retry 使用相同 request，交由 transport 保持 idempotent', async () => {
  const receipts = new Map();
  const calls = [];
  const fake = {
    async upsertSummary(request) {
      calls.push(request);
      const key = `${request.marker}:${request.headSha}:${request.candidateDigest}`;
      if (!receipts.has(key)) receipts.set(key, { ok: true, status: 200, id: 'summary-stable' });
      return receipts.get(key);
    },
    async upsertCheck() {
      return { ok: true, status: 200, id: 'check-stable' };
    },
  };
  const first = await publishGithubResult(fake, payload());
  const retry = await publishGithubResult(fake, payload());

  assert.equal(first.published, true);
  assert.deepEqual(retry, first);
  assert.deepEqual(calls[0], calls[1]);
});
