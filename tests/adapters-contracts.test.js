import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalRuntimeContext,
  createAnalysisContextBinding,
  validateAdapterResult,
} from '../src/adapters/contracts.js';

const runtimeContext = {
  namespace: 'server',
  id: 'server:api',
  version: 'node-24',
  source: 'adapter',
};

const adapterResult = {
  adapterSet: [{
    id: 'blade-v1',
    version: '1.0.0',
    languages: ['php', 'html', 'javascript'],
    capabilities: ['changed-regions', 'runtime-context'],
  }, {
    id: 'javascript-v1',
    version: '1.0.0',
    languages: ['javascript'],
    capabilities: ['changed-regions', 'runtime-context'],
  }],
  obligations: [{
    id: 'COV-BLADE-001',
    required: true,
    status: 'COMPLETE',
    changedRegions: [{
      path: 'resources/views/page.blade.php',
      startByte: 0,
      endByte: 10,
      language: 'php',
      adapterId: 'blade-v1',
      runtimeContext,
    }, {
      path: 'resources/views/page.blade.php',
      startByte: 10,
      endByte: 20,
      language: 'javascript',
      adapterId: 'javascript-v1',
      runtimeContext: { ...runtimeContext, namespace: 'client', id: 'client:browser' },
    }],
  }],
  diagnostics: [],
  evidenceReferences: [],
  complete: true,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function changed(mutator) {
  const input = clone(adapterResult);
  mutator(input);
  return input;
}

test('多 Adapter 與 region-level runtime context 可建立穩定 binding', () => {
  const result = validateAdapterResult(adapterResult);
  const binding = createAnalysisContextBinding(adapterResult);

  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(binding.adapterSet.length, 2);
  assert.match(binding.adapterSetDigest, /^[a-f0-9]{64}$/);
  assert.match(binding.executionContextDigest, /^[a-f0-9]{64}$/);
});

test('runtime context 可 canonicalize 已知 namespace，unknown 則由 contract 保留為 blocker', () => {
  const validNamespaces = ['server', 'client', 'edge', 'worker', 'external', 'unknown'];

  for (const namespace of validNamespaces) {
    const id = `${namespace}:runtime`;
    assert.deepEqual(canonicalRuntimeContext({ ...runtimeContext, namespace, id }), {
      id,
      namespace,
      source: 'adapter',
      version: 'node-24',
    });
    if (namespace !== 'unknown') {
      const input = changed((result) => {
        result.obligations[0].changedRegions[0].runtimeContext = {
          ...runtimeContext,
          namespace,
          id,
        };
      });
      assert.deepEqual(validateAdapterResult(input), { valid: true, errors: [] }, namespace);
    }
  }

  const unknownInput = changed((result) => {
    result.obligations[0].changedRegions[0].runtimeContext = {
      ...runtimeContext,
      namespace: 'unknown',
      id: 'unknown:runtime',
    };
  });
  assert.deepEqual(validateAdapterResult(unknownInput), { valid: true, errors: [] }, 'unknown');

  assert.deepEqual(canonicalRuntimeContext({ ...runtimeContext, version: undefined }), {
    id: 'server:api',
    namespace: 'server',
    source: 'adapter',
    version: null,
  });
  assert.equal(canonicalRuntimeContext({ ...runtimeContext, namespace: 'desktop' }), null);
  assert.equal(canonicalRuntimeContext({ ...runtimeContext, id: '' }), null);
  assert.equal(canonicalRuntimeContext({ ...runtimeContext, source: '' }), null);
  assert.equal(canonicalRuntimeContext({ ...runtimeContext, version: 24 }), null);
});

test('合法 incomplete result 必須有 stable reason code', () => {
  const input = changed((result) => {
    result.obligations[0].status = 'PARTIAL_PARSE';
    result.complete = false;
    result.reasonCode = 'PARTIAL_PARSE';
    result.diagnostics = ['PARTIAL_PARSE'];
  });

  assert.deepEqual(validateAdapterResult(input), { valid: true, errors: [] });
});

test('AdapterResult 缺欄位、錯型別、矛盾或未知值一律 fail-closed', () => {
  const cases = [
    ['缺少 AdapterSet', changed((result) => { delete result.adapterSet; }), 'ADAPTER_SET_MISSING'],
    ['重複 adapter id', changed((result) => { result.adapterSet[1].id = 'blade-v1'; }), 'ADAPTER_SET_DUPLICATE_ID'],
    ['缺少 adapter id', changed((result) => { result.adapterSet[0].id = ''; }), 'ADAPTER_ID_MISSING'],
    ['缺少 adapter version', changed((result) => { result.adapterSet[0].version = ''; }), 'ADAPTER_VERSION_MISSING:blade-v1'],
    ['空 language list', changed((result) => { result.adapterSet[0].languages = []; }), 'ADAPTER_LANGUAGES_MISSING:blade-v1'],
    ['language 型別錯誤', changed((result) => { result.adapterSet[0].languages = ['php', 1]; }), 'ADAPTER_LANGUAGES_INVALID:blade-v1'],
    ['重複 language', changed((result) => { result.adapterSet[0].languages = ['php', 'php']; }), 'ADAPTER_LANGUAGES_DUPLICATE:blade-v1'],
    ['缺少 capabilities', changed((result) => { delete result.adapterSet[0].capabilities; }), 'ADAPTER_CAPABILITIES_MISSING:blade-v1'],
    ['capability 型別錯誤', changed((result) => { result.adapterSet[0].capabilities = ['changed-regions', 1]; }), 'ADAPTER_CAPABILITIES_INVALID:blade-v1'],
    ['重複 capability', changed((result) => { result.adapterSet[0].capabilities = ['changed-regions', 'changed-regions']; }), 'ADAPTER_CAPABILITIES_DUPLICATE:blade-v1'],
    ['未知 capability', changed((result) => { result.adapterSet[0].capabilities = ['unknown-capability']; }), 'ADAPTER_CAPABILITY_UNKNOWN:blade-v1:unknown-capability'],
    ['缺少 obligations', changed((result) => { delete result.obligations; }), 'ADAPTER_OBLIGATIONS_MISSING'],
    ['重複 obligation id', changed((result) => { result.obligations.push(clone(result.obligations[0])); }), 'ADAPTER_OBLIGATION_DUPLICATE_ID'],
    ['缺少 obligation id', changed((result) => { result.obligations[0].id = ''; }), 'ADAPTER_OBLIGATION_ID_MISSING'],
    ['required 型別錯誤', changed((result) => { result.obligations[0].required = 'yes'; }), 'ADAPTER_REQUIRED_INVALID:COV-BLADE-001'],
    ['未知 terminal status', changed((result) => { result.obligations[0].status = 'GARBAGE'; }), 'ADAPTER_STATUS_INVALID:COV-BLADE-001'],
    ['缺少 changed regions', changed((result) => { delete result.obligations[0].changedRegions; }), 'ADAPTER_CHANGED_REGIONS_MISSING:COV-BLADE-001'],
    ['required COMPLETE 沒有 region', changed((result) => { result.obligations[0].changedRegions = []; }), 'ADAPTER_REQUIRED_REGIONS_MISSING:COV-BLADE-001'],
    ['負數 range', changed((result) => { result.obligations[0].changedRegions[0].startByte = -1; }), 'REGION_RANGE_INVALID:COV-BLADE-001'],
    ['零長度 range', changed((result) => { result.obligations[0].changedRegions[0].endByte = 0; }), 'REGION_RANGE_INVALID:COV-BLADE-001'],
    ['反向 range', changed((result) => { result.obligations[0].changedRegions[0].endByte = -1; }), 'REGION_RANGE_INVALID:COV-BLADE-001'],
    ['缺少 path', changed((result) => { result.obligations[0].changedRegions[0].path = ''; }), 'REGION_PATH_MISSING:COV-BLADE-001'],
    ['缺少 language', changed((result) => { result.obligations[0].changedRegions[0].language = ''; }), 'REGION_LANGUAGE_MISSING:COV-BLADE-001'],
    ['缺少 region adapter', changed((result) => { result.obligations[0].changedRegions[0].adapterId = ''; }), 'REGION_ADAPTER_MISSING:COV-BLADE-001'],
    ['region 使用未宣告 adapter', changed((result) => { result.obligations[0].changedRegions[0].adapterId = 'unknown-v1'; }), 'REGION_ADAPTER_UNDECLARED:unknown-v1'],
    ['adapter 不支援 region language', changed((result) => { result.obligations[0].changedRegions[0].language = 'ruby'; }), 'REGION_LANGUAGE_UNSUPPORTED:blade-v1:ruby'],
    ['region 缺 runtime context', changed((result) => { delete result.obligations[0].changedRegions[0].runtimeContext; }), 'REGION_RUNTIME_CONTEXT_INVALID:COV-BLADE-001'],
    ['非法 runtime namespace', changed((result) => { result.obligations[0].changedRegions[0].runtimeContext.namespace = 'desktop'; }), 'REGION_RUNTIME_CONTEXT_INVALID:COV-BLADE-001'],
    ['runtime namespace 與 id 不符', changed((result) => { result.obligations[0].changedRegions[0].runtimeContext.id = 'client:browser'; }), 'REGION_RUNTIME_NAMESPACE_MISMATCH:COV-BLADE-001'],
    ['重疊 region', changed((result) => { result.obligations[0].changedRegions[1] = { ...result.obligations[0].changedRegions[0], startByte: 5, endByte: 15 }; }), 'REGION_OVERLAP:COV-BLADE-001'],
    ['缺少 diagnostics', changed((result) => { delete result.diagnostics; }), 'ADAPTER_DIAGNOSTICS_MISSING'],
    ['diagnostic 型別錯誤', changed((result) => { result.diagnostics = ['VALID', 1]; }), 'ADAPTER_DIAGNOSTICS_INVALID'],
    ['重複 diagnostic', changed((result) => { result.diagnostics = ['ONE', 'ONE']; }), 'ADAPTER_DIAGNOSTICS_DUPLICATE'],
    ['缺少 evidence references', changed((result) => { delete result.evidenceReferences; }), 'ADAPTER_EVIDENCE_REFERENCES_MISSING'],
    ['evidence reference 型別錯誤', changed((result) => { result.evidenceReferences = ['E-1', '']; }), 'ADAPTER_EVIDENCE_REFERENCES_INVALID'],
    ['重複 evidence reference', changed((result) => { result.evidenceReferences = ['E-1', 'E-1']; }), 'ADAPTER_EVIDENCE_REFERENCES_DUPLICATE'],
    ['complete 型別錯誤', changed((result) => { result.complete = 'yes'; }), 'ADAPTER_COMPLETE_INVALID'],
    ['incomplete 缺 stable reason', changed((result) => { result.complete = false; }), 'ADAPTER_REASON_CODE_MISSING'],
    ['incomplete reason 不得空白', changed((result) => { result.complete = false; result.reasonCode = ' '; }), 'ADAPTER_REASON_CODE_MISSING'],
    ['complete 不得帶 incomplete reason', changed((result) => { result.reasonCode = 'PARTIAL_PARSE'; }), 'ADAPTER_REASON_CODE_UNEXPECTED'],
    ['required terminal 不完整卻宣告 complete', changed((result) => { result.obligations[0].status = 'PARTIAL_PARSE'; }), 'ADAPTER_COMPLETE_STATUS_MISMATCH:COV-BLADE-001'],
  ];

  for (const [name, input, error] of cases) {
    const result = validateAdapterResult(input);
    assert.equal(result.valid, false, name);
    assert.ok(result.errors.includes(error), `${name}: ${result.errors.join(',')}`);
  }
});

test('相鄰或未排序但不重疊的 regions 都合法，digest 不受輸入順序影響', () => {
  const reordered = changed((result) => {
    result.adapterSet.reverse();
    result.obligations[0].changedRegions.reverse();
  });

  assert.deepEqual(validateAdapterResult(reordered), { valid: true, errors: [] });
  assert.deepEqual(createAnalysisContextBinding(reordered), createAnalysisContextBinding(adapterResult));
});

test('不同 path 的相同 byte range 不視為重疊', () => {
  const input = changed((result) => {
    result.obligations[0].changedRegions[1] = {
      ...result.obligations[0].changedRegions[0],
      path: 'resources/views/other.blade.php',
    };
  });

  assert.deepEqual(validateAdapterResult(input), { valid: true, errors: [] });
});

test('adapterSetDigest 只綁定全部 adapter id/version，execution digest 綁定 region context', () => {
  const languagesChanged = changed((result) => {
    result.adapterSet[0].languages.push('typescript');
  });
  const versionChanged = changed((result) => {
    result.adapterSet[0].version = '2.0.0';
  });
  const runtimeChanged = changed((result) => {
    result.obligations[0].changedRegions[0].runtimeContext.id = 'server:worker';
  });
  const baseline = createAnalysisContextBinding(adapterResult);

  assert.equal(createAnalysisContextBinding(languagesChanged).adapterSetDigest, baseline.adapterSetDigest);
  assert.notEqual(createAnalysisContextBinding(versionChanged).adapterSetDigest, baseline.adapterSetDigest);
  assert.notEqual(createAnalysisContextBinding(runtimeChanged).executionContextDigest, baseline.executionContextDigest);
});
