import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalysis } from '../src/runner.js';
import { createMemoryAuthorityStore } from '../src/storage/memory-authority-store.js';
import { SqliteAuthorityStore } from '../src/storage/sqlite-authority-store.js';
import { createAnalysisContextBinding } from '../src/adapters/contracts.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-storage-001',
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

function candidate(overrides = {}) {
  return runAnalysis({ ...input, ...overrides });
}

function contextBinding(path) {
  return createAnalysisContextBinding({
    adapterSet: [{
      id: 'javascript-v1',
      version: '1',
      languages: ['javascript'],
      capabilities: ['changed-regions', 'runtime-context'],
    }],
    obligations: [{
      id: 'COV-CONTEXT-001',
      required: false,
      status: 'COMPLETE',
      changedRegions: [{
        path,
        startByte: 0,
        endByte: 10,
        language: 'javascript',
        adapterId: 'javascript-v1',
        runtimeContext: {
          namespace: 'server',
          id: 'server:api',
          version: 'node-24',
          source: 'adapter',
        },
      }],
    }],
    diagnostics: [],
    evidenceReferences: [],
    complete: true,
  });
}

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'review-reduction-storage-'));
  return {
    directory,
    path: join(directory, 'authority.sqlite'),
  };
}

test('memory store 可以初始化並讀回 current head', () => {
  const store = createMemoryAuthorityStore({ repository: identity.repository, currentHead: identity });

  assert.deepEqual(store.readCurrentHead(identity.repository), identity);
  assert.equal(store.readCurrent(identity.repository), null);
});

test('stale CAS 不修改 current head 或 current candidate', () => {
  const nextIdentity = { ...identity, headSha: 'head-storage-002' };
  const store = createMemoryAuthorityStore({ repository: identity.repository, currentHead: identity });
  const initialCandidate = candidate();

  assert.equal(store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: initialCandidate,
  }).accepted, true);
  assert.equal(store.advanceCurrentHead({
    repository: identity.repository,
    expectedHead: identity,
    nextHead: nextIdentity,
  }).accepted, true);

  const stale = store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: initialCandidate,
  });

  assert.deepEqual(stale, { accepted: false, reason: 'AUTHORITY_CAS_STALE' });
  assert.deepEqual(store.readCurrentHead(identity.repository), nextIdentity);
  assert.equal(store.readCurrent(identity.repository), null);
});

test('advanceCurrentHead 原子更新 head 並清除舊 candidate', () => {
  const nextIdentity = { ...identity, headSha: 'head-storage-002' };
  const store = createMemoryAuthorityStore({ repository: identity.repository, currentHead: identity });
  const initialCandidate = candidate();

  store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: initialCandidate,
  });
  const result = store.advanceCurrentHead({
    repository: identity.repository,
    expectedHead: identity,
    nextHead: nextIdentity,
  });

  assert.deepEqual(result, { accepted: true, currentHead: nextIdentity });
  assert.equal(store.readCurrent(identity.repository), null);
});

test('same digest retry idempotent，same head 不同 digest 回傳 conflict', () => {
  const store = createMemoryAuthorityStore({ repository: identity.repository, currentHead: identity });
  const initialCandidate = candidate();
  const differentCandidate = candidate({ riskBlockers: ['risk:changed'] });

  const first = store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: initialCandidate,
  });
  const retry = store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: initialCandidate,
  });
  const conflict = store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: differentCandidate,
  });

  assert.equal(first.accepted, true);
  assert.deepEqual(retry, {
    accepted: true,
    idempotent: true,
    current: first.current,
  });
  assert.deepEqual(conflict, { accepted: false, reason: 'AUTHORITY_CAS_CONFLICT' });
  assert.deepEqual(store.readCurrent(identity.repository), first.current);
});

test('context binding mismatch 也必須是 stale 且不得寫入 candidate', () => {
  const authorityBinding = contextBinding('src/authority.js');
  const candidateBinding = contextBinding('src/other.js');
  const store = createMemoryAuthorityStore({
    repository: identity.repository,
    currentHead: identity,
    currentContextBinding: authorityBinding,
  });

  const result = store.compareAndSwapCurrent({
    repository: identity.repository,
    expectedHead: identity,
    candidate: candidate({ contextBinding: candidateBinding }),
  });

  assert.deepEqual(result, { accepted: false, reason: 'AUTHORITY_CAS_STALE' });
  assert.equal(store.readCurrent(identity.repository), null);
});

test('SQLite close/reopen 後仍能讀回 authority，舊 run 不能覆寫新 head', async () => {
  const database = await temporaryDatabase();
  const nextIdentity = { ...identity, headSha: 'head-storage-002' };
  try {
    const firstStore = new SqliteAuthorityStore(database.path);
    firstStore.initialize({ repository: identity.repository, currentHead: identity });
    const initialCandidate = candidate();
    const published = firstStore.compareAndSwapCurrent({
      repository: identity.repository,
      expectedHead: identity,
      candidate: initialCandidate,
    });
    firstStore.close();

    const reopened = new SqliteAuthorityStore(database.path);
    assert.deepEqual(reopened.readCurrentHead(identity.repository), identity);
    assert.deepEqual(reopened.readCurrent(identity.repository), published.current);

    assert.deepEqual(reopened.advanceCurrentHead({
      repository: identity.repository,
      expectedHead: identity,
      nextHead: nextIdentity,
    }), { accepted: true, currentHead: nextIdentity });
    assert.deepEqual(reopened.compareAndSwapCurrent({
      repository: identity.repository,
      expectedHead: identity,
      candidate: initialCandidate,
    }), { accepted: false, reason: 'AUTHORITY_CAS_STALE' });
    assert.equal(reopened.readCurrent(identity.repository), null);
    reopened.close();
  } finally {
    await rm(database.directory, { recursive: true, force: true });
  }
});
