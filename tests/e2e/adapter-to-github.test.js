import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalysisContextBinding } from '../../src/adapters/contracts.js';
import { createReferenceAdapter } from '../../src/adapters/reference-adapter.js';
import { createMemoryAuthorityStore } from '../../src/storage/memory-authority-store.js';
import { SqliteAuthorityStore } from '../../src/storage/sqlite-authority-store.js';
import { runStoredAdapterPipeline } from '../../src/runner.js';

async function fixture(name) {
  const source = await readFile(new URL(`../../fixtures/e2e/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

function successfulTransport(calls = []) {
  return {
    async upsertSummary(request) {
      calls.push({ type: 'summary', request });
      return { ok: true, status: 200, id: 'summary-e2e-1' };
    },
    async upsertCheck(request) {
      calls.push({ type: 'check', request });
      return { ok: true, status: 200, id: 'check-e2e-1' };
    },
  };
}

function failureTransport() {
  return {
    async upsertSummary() {
      return { ok: false, status: 503 };
    },
    async upsertCheck() {
      return { ok: true, status: 200, id: 'check-e2e-1' };
    },
  };
}

function storeFor(scenario) {
  return createMemoryAuthorityStore({
    repository: scenario.identity.repository,
    currentHead: scenario.identity,
    currentContextBinding: createAnalysisContextBinding(scenario.adapterResult),
  });
}

async function runScenario(scenario, transport = successfulTransport()) {
  const store = storeFor(scenario);
  const result = await runStoredAdapterPipeline(
    createReferenceAdapter(scenario),
    { identity: scenario.identity },
    store,
    transport,
    { timeoutMs: 50 },
  );
  return { result, store };
}

test('mixed-language complete 走 adapter → normalization → CAS → Summary/check sink', async () => {
  const scenario = await fixture('mixed-language-complete');
  const { result } = await runScenario(scenario);

  assert.equal(result.candidate.coverage.status, scenario.expected.coverageStatus);
  assert.equal(result.candidate.decision.status, scenario.expected.decisionStatus);
  assert.equal(result.delivery.published, scenario.expected.deliveryPublished);
  assert.equal(result.check.state, 'PASS');
});

test('partial parse、unknown runtime、adapter-declared timeout 都保留 Human Review', async () => {
  const matrix = await fixture('partial-runtime-unknown');
  for (const scenario of Object.values(matrix)) {
    if (!scenario.expected) continue;
    const { result } = await runScenario(scenario);

    assert.equal(result.candidate.coverage.status, scenario.expected.coverageStatus);
    assert.equal(result.candidate.decision.status, scenario.expected.decisionStatus);
    assert.equal(result.candidate.decision.fallback, scenario.expected.fallback);
    assert.notEqual(result.candidate.decision.status, 'NOT_SELECTED_FOR_HUMAN_REVIEW');
    assert.equal(result.check.state, 'PASS');
  }
});

test('GitHub transport failure 只產生 delivery failure，不改寫 authoritative candidate', async () => {
  const scenario = await fixture('mixed-language-complete');
  const { result, store } = await runScenario(scenario, failureTransport());

  assert.deepEqual(result.delivery, {
    published: false,
    reason: 'GITHUB_PUBLICATION_FAILED',
  });
  assert.equal(result.check.state, 'PASS');
  assert.deepEqual(store.readCurrent(scenario.identity.repository), result.candidate);
});

test('new head 在舊 run publication 前到達時，舊 run no-op 且不呼叫 sink', async () => {
  const scenario = await fixture('mixed-language-complete');
  const binding = createAnalysisContextBinding(scenario.adapterResult);
  const store = createMemoryAuthorityStore({
    repository: scenario.identity.repository,
    currentHead: scenario.identity,
    currentContextBinding: binding,
  });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const calls = [];
  const pipeline = runStoredAdapterPipeline({
    async analyze() {
      markStarted();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      return scenario.adapterResult;
    },
  }, { identity: scenario.identity }, store, successfulTransport(calls), { timeoutMs: 100 });

  await started;
  assert.deepEqual(store.advanceCurrentHead({
    repository: scenario.identity.repository,
    expectedHead: scenario.identity,
    nextHead: { ...scenario.identity, headSha: 'head-e2e-new-before-publish' },
    nextContextBinding: binding,
  }), {
    accepted: true,
    currentHead: { ...scenario.identity, headSha: 'head-e2e-new-before-publish' },
  });
  const result = await pipeline;

  assert.deepEqual(result.publication, {
    accepted: false,
    reason: 'AUTHORITY_CAS_STALE',
  });
  assert.equal(result.delivery, null);
  assert.deepEqual(calls, []);
});

test('SQLite restart 後 advance head，舊 run 仍然 stale 且不覆寫 authority', async () => {
  const fixtureData = await fixture('stale-after-restart');
  const scenario = fixtureData.oldRun;
  const binding = createAnalysisContextBinding(scenario.adapterResult);
  const directory = await mkdtemp(join(tmpdir(), 'review-reduction-e2e-'));
  const databasePath = join(directory, 'authority.sqlite');
  try {
    const firstStore = new SqliteAuthorityStore(databasePath);
    firstStore.initialize({
      repository: scenario.identity.repository,
      currentHead: scenario.identity,
      currentContextBinding: binding,
    });
    const first = await runStoredAdapterPipeline(
      createReferenceAdapter(scenario),
      { identity: scenario.identity },
      firstStore,
      successfulTransport(),
      { timeoutMs: 50 },
    );
    assert.equal(first.publication.accepted, true);
    firstStore.close();

    const restarted = new SqliteAuthorityStore(databasePath);
    assert.deepEqual(restarted.readCurrentHead(scenario.identity.repository), scenario.identity);
    assert.deepEqual(restarted.advanceCurrentHead({
      repository: scenario.identity.repository,
      expectedHead: scenario.identity,
      nextHead: fixtureData.newIdentity,
      nextContextBinding: binding,
    }), { accepted: true, currentHead: fixtureData.newIdentity });

    const calls = [];
    const stale = await runStoredAdapterPipeline(
      createReferenceAdapter(scenario),
      { identity: scenario.identity },
      restarted,
      successfulTransport(calls),
      { timeoutMs: 50 },
    );
    assert.deepEqual(stale.publication, {
      accepted: false,
      reason: fixtureData.expected.publicationReason,
    });
    assert.deepEqual(stale.check, {
      state: fixtureData.expected.checkState,
      reason: fixtureData.expected.checkReason,
    });
    assert.equal(calls.length, fixtureData.expected.deliveryCalls);
    assert.equal(restarted.readCurrent(scenario.identity.repository), null);
    restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
