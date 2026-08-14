import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityState } from '../../src/publication.js';
import { runAdapterPipeline } from '../../src/runner.js';
import { createAnalysisContextBinding, validateAdapterResult } from '../../src/adapters/contracts.js';
import { runAdapter } from '../../src/adapters/runner.js';

const identity = {
  repository: 'example/repo',
  baseSha: 'base-001',
  headSha: 'head-execution-001',
  policyId: 'policy-001',
  policyVersion: '1',
  runnerVersion: '1',
};

function adapterResult(status = 'COMPLETE') {
  const incomplete = status !== 'COMPLETE';
  return {
    adapterSet: [{
      id: 'javascript-v1',
      version: '1.0.0',
      languages: ['javascript'],
      capabilities: ['changed-regions', 'runtime-context', 'coverage-obligations'],
    }],
    obligations: [{
      id: 'COV-EXEC-001',
      required: true,
      status,
      changedRegions: incomplete ? [] : [{
        path: 'src/example.js',
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
    diagnostics: incomplete ? [status] : [],
    evidenceReferences: [],
    complete: !incomplete,
    ...(incomplete ? { reasonCode: status } : {}),
  };
}

function stateFor(result) {
  return createAuthorityState(identity, createAnalysisContextBinding(result));
}

function delayedResult(result, delayMs) {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => resolve(result), delayMs);
  });
}

test('runAdapter 成功時回傳已驗證的 AdapterResult，不產生 reduction decision', async () => {
  const result = adapterResult();
  const execution = await runAdapter({
    analyze: async () => result,
  }, { identity }, { timeoutMs: 50 });

  assert.deepEqual(execution, {
    ok: true,
    identity,
    adapterResult: result,
  });
  assert.deepEqual(validateAdapterResult(execution.adapterResult), { valid: true, errors: [] });
  assert.equal('decision' in execution, false);
});

test('Adapter 宣告 obligation TIMEOUT 時由 pipeline 保留 INCOMPLETE 與 Human Review', async () => {
  const result = adapterResult('TIMEOUT');
  const pipeline = await runAdapterPipeline({
    analyze: async () => result,
  }, { identity }, stateFor(result), { timeoutMs: 50 });

  assert.equal(pipeline.publication.accepted, true);
  assert.equal(pipeline.candidate.coverage.status, 'INCOMPLETE');
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.candidate.decision.fallback, 'FULL');
  assert.deepEqual(pipeline.check, {
    state: 'PASS',
    reason: 'CURRENT_AUTHORITATIVE_SUMMARY',
  });
});

test('execution deadline timeout 會回傳 failure，且 late result 不得修改 authority', async () => {
  let adapterSignal;
  const state = stateFor(adapterResult());
  const baseline = await runAdapterPipeline({
    analyze: async () => adapterResult(),
  }, { identity }, state, { timeoutMs: 50 });
  const authoritativeBeforeFailure = state.current;
  assert.equal(baseline.publication.accepted, true);

  const pipeline = await runAdapterPipeline({
    analyze: (_request, { signal }) => {
      adapterSignal = signal;
      return delayedResult(adapterResult(), 30);
    },
  }, { identity }, state, { timeoutMs: 5 });

  assert.equal(pipeline.publication.accepted, false);
  assert.deepEqual(pipeline.publication, {
    accepted: false,
    reason: 'ADAPTER_EXECUTION_TIMEOUT',
  });
  assert.deepEqual(pipeline.check, {
    state: 'FAILURE',
    reason: 'ADAPTER_EXECUTION_TIMEOUT',
  });
  assert.equal(pipeline.candidate.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(pipeline.candidate.decision.fallback, 'FULL');
  assert.equal(adapterSignal.aborted, true);
  assert.equal(state.current, authoritativeBeforeFailure);

  await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
  assert.equal(state.current, authoritativeBeforeFailure);
});

test('adapter exception 會回傳 ADAPTER_EXCEPTION，且不暴露 stack trace', async () => {
  const state = createAuthorityState(identity);
  const pipeline = await runAdapterPipeline({
    analyze: async () => {
      throw new Error('secret adapter stack');
    },
  }, { identity }, state, { timeoutMs: 50 });

  assert.deepEqual(pipeline.publication, {
    accepted: false,
    reason: 'ADAPTER_EXCEPTION',
  });
  assert.deepEqual(pipeline.check, {
    state: 'FAILURE',
    reason: 'ADAPTER_EXCEPTION',
  });
  assert.doesNotMatch(JSON.stringify(pipeline), /secret adapter stack|Error:|at /);
  assert.equal(state.current, null);
});

test('malformed AdapterResult 會回傳 ADAPTER_RESULT_INVALID 且不得進入 reduction', async () => {
  const state = createAuthorityState(identity);
  const pipeline = await runAdapterPipeline({
    analyze: async () => ({ malformed: true }),
  }, { identity }, state, { timeoutMs: 50 });

  assert.equal(pipeline.publication.accepted, false);
  assert.equal(pipeline.publication.reason, 'ADAPTER_RESULT_INVALID');
  assert.equal(pipeline.candidate.analysisStatus, 'ANALYSIS_FAILED');
  assert.equal(pipeline.candidate.decision.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(pipeline.check.state, 'FAILURE');
  assert.equal(state.current, null);
});

test('pre-aborted signal 會回傳 ADAPTER_ABORTED 且不執行 adapter', async () => {
  let called = false;
  const execution = await runAdapter({
    analyze: async () => {
      called = true;
      return adapterResult();
    },
  }, { identity }, { signal: { aborted: true }, timeoutMs: 50 });

  assert.deepEqual(execution, {
    ok: false,
    identity,
    code: 'ADAPTER_ABORTED',
    input: {
      identity,
      analysisError: 'ADAPTER_ABORTED',
      diagnostics: ['ADAPTER_ABORTED'],
    },
  });
  assert.equal(called, false);
});

test('執行中的外部 AbortSignal 會中止 adapter 且不發布結果', async () => {
  const controller = new globalThis.AbortController();
  let resolveLate;
  let adapterSignal;
  let markStarted;
  const adapterStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const state = createAuthorityState(identity);
  const pipelinePromise = runAdapterPipeline({
    analyze: (_request, { signal }) => {
      adapterSignal = signal;
      markStarted();
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    },
  }, { identity }, state, { signal: controller.signal, timeoutMs: 50 });

  await adapterStarted;
  controller.abort();
  const pipeline = await pipelinePromise;

  assert.deepEqual(pipeline.publication, {
    accepted: false,
    reason: 'ADAPTER_ABORTED',
  });
  assert.deepEqual(pipeline.check, {
    state: 'FAILURE',
    reason: 'ADAPTER_ABORTED',
  });
  assert.equal(adapterSignal.aborted, true);
  assert.equal(state.current, null);

  resolveLate(adapterResult());
});
