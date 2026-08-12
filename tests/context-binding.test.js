import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalysisContextBinding,
  sameAnalysisContextBinding,
  validateAnalysisContextBinding,
} from '../src/adapters/contracts.js';

const adapterResult = {
  adapterSet: [{
    id: 'javascript-v1',
    version: '1.0.0',
    languages: ['javascript'],
    capabilities: ['changed-regions', 'runtime-context'],
  }],
  obligations: [{
    id: 'COV-1',
    required: true,
    status: 'COMPLETE',
    changedRegions: [{
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
  diagnostics: [],
  evidenceReferences: [],
  complete: true,
};

test('context binding 的 digest 必須可由 adapter set 與 region context 重算', () => {
  const binding = createAnalysisContextBinding(adapterResult);

  assert.deepEqual(validateAnalysisContextBinding(binding), { valid: true, errors: [] });
  assert.equal(sameAnalysisContextBinding(binding, JSON.parse(JSON.stringify(binding))), true);

  const tampered = JSON.parse(JSON.stringify(binding));
  tampered.regions[0].runtimeContext.id = 'server:worker';
  assert.deepEqual(validateAnalysisContextBinding(tampered), {
    valid: false,
    errors: ['EXECUTION_CONTEXT_DIGEST_MISMATCH'],
  });
  assert.equal(sameAnalysisContextBinding(binding, tampered), false);
});

test('合法 incomplete AdapterResult 即使沒有 region 仍可綁定空 execution context', () => {
  const binding = createAnalysisContextBinding({
    ...adapterResult,
    obligations: [{
      id: 'COV-1',
      required: true,
      status: 'UNSUPPORTED',
      changedRegions: [],
    }],
    diagnostics: ['UNSUPPORTED'],
    complete: false,
    reasonCode: 'UNSUPPORTED',
  });

  assert.deepEqual(validateAnalysisContextBinding(binding), { valid: true, errors: [] });
});

test('缺少 binding 回傳 stable failure，invalid AdapterResult 不得建立 binding', () => {
  assert.deepEqual(validateAnalysisContextBinding(), {
    valid: false,
    errors: ['ANALYSIS_CONTEXT_BINDING_MISSING'],
  });
  assert.throws(
    () => createAnalysisContextBinding({}),
    /^Error: ADAPTER_RESULT_INVALID:/,
  );
});
