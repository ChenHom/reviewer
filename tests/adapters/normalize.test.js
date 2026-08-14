import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeAdapterResult } from '../../src/adapters/normalize.js';

async function fixture(name) {
  const source = await readFile(new URL(`../../fixtures/adapters/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(source);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('mixed-language regions normalization 會排序且保留 language、adapter 與 runtime ownership', async () => {
  const input = await fixture('mixed-language-blade');
  const normalized = normalizeAdapterResult(input);
  const regions = normalized.coverage.obligations[0].changedRegions;

  assert.equal(normalized.identity.headSha, 'head-mixed-001');
  assert.equal(normalized.coverage.obligations[0].status, 'COMPLETE');
  assert.deepEqual(regions.map(({ startByte, endByte, language, adapterId, runtime }) => ({
    startByte,
    endByte,
    language,
    adapterId,
    runtime,
  })), [
    { startByte: 0, endByte: 40, language: 'php', adapterId: 'blade-reference-v1', runtime: 'server' },
    { startByte: 40, endByte: 80, language: 'html', adapterId: 'blade-reference-v1', runtime: 'client' },
    { startByte: 80, endByte: 120, language: 'javascript', adapterId: 'blade-reference-v1', runtime: 'client' },
  ]);
  assert.deepEqual(normalized.riskBlockers, []);
  assert.deepEqual(normalized.policyRequirements, []);
  assert.equal(normalized.audit, false);
});

test('adapter terminal status 會映射到 core coverage status 並保留 reason code', async () => {
  const input = await fixture('mixed-language-blade');
  const cases = [
    ['PARTIAL_PARSE', 'INCOMPLETE'],
    ['UNSUPPORTED', 'INCOMPLETE'],
    ['TIMEOUT', 'INCOMPLETE'],
    ['TRUNCATED', 'INCOMPLETE'],
    ['FAILED', 'FAILED'],
  ];

  for (const [adapterStatus, coverageStatus] of cases) {
    const result = clone(input);
    result.adapterResult.obligations[0].status = adapterStatus;
    result.adapterResult.obligations[0].changedRegions = [];
    result.adapterResult.complete = false;
    result.adapterResult.reasonCode = adapterStatus;
    result.adapterResult.diagnostics = [adapterStatus];

    const normalized = normalizeAdapterResult(result);
    assert.equal(normalized.coverage.obligations[0].status, coverageStatus, adapterStatus);
    assert.equal(normalized.coverage.obligations[0].reasonCode, adapterStatus, adapterStatus);
  }
});

test('非必要 unsupported obligation 不會被 normalization 轉成 reduction success blocker', async () => {
  const input = await fixture('mixed-language-blade');
  input.adapterResult.obligations.push({
    id: 'COV-OPTIONAL-001',
    required: false,
    status: 'UNSUPPORTED',
    changedRegions: [],
  });

  const normalized = normalizeAdapterResult(input);

  assert.equal(normalized.coverage.obligations[0].status, 'COMPLETE');
  assert.equal(normalized.coverage.obligations[1].status, 'INCOMPLETE');
  assert.equal(normalized.coverage.obligations[1].required, false);
});

test('零長度、重疊、缺 language 或不同 path 的非法 region 不會產生空 coverage 或 ELIGIBLE', async () => {
  const input = await fixture('mixed-language-blade');
  const cases = [
    ['zero-length', (region) => { region.endByte = region.startByte; }],
    ['overlap', (region) => { region.startByte = 20; }],
    ['missing-language', (region) => { delete region.language; }],
    ['different-path-overlap-is-valid', (region) => { region.path = 'resources/views/other.blade.php'; }],
  ];

  for (const [name, mutate] of cases) {
    const result = clone(input);
    mutate(result.adapterResult.obligations[0].changedRegions[0]);
    if (name === 'overlap') {
      result.adapterResult.obligations[0].changedRegions[1].startByte = 20;
    }

    const normalized = normalizeAdapterResult(result);
    if (name === 'different-path-overlap-is-valid') {
      assert.equal(normalized.coverage.obligations[0].status, 'COMPLETE', name);
      continue;
    }

    assert.match(normalized.analysisError, /^ADAPTER_RESULT_INVALID:/, name);
    assert.equal('coverage' in normalized, false, name);
    assert.equal('eligibility' in normalized, false, name);
  }
});
