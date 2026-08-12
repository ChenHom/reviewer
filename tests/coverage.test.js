import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE } from '../src/contracts.js';
import { evaluateCoverage } from '../src/coverage.js';

const region = {
  path: 'src/payment.js',
  startByte: 0,
  endByte: 10,
  language: 'javascript',
  adapterId: 'javascript-v1',
  runtime: 'server',
};

test('所有必要 obligation 完成時回傳 COMPLETE', () => {
  const result = evaluateCoverage({
    obligations: [{ id: 'COV-LANG-001', required: true, status: 'COMPLETE', changedRegions: [region] }],
  });

  assert.deepEqual(result, { status: COVERAGE.COMPLETE, blockers: [] });
});

test('將 PARTIAL_PARSE 保留為 reduction blocker', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'INCOMPLETE',
      reasonCode: 'PARTIAL_PARSE',
      changedRegions: [region],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:PARTIAL_PARSE'],
  });
});

test('changed region 使用未知 runtime 時阻止 reduction', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{ ...region, runtime: 'unknown' }],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:UNKNOWN_RUNTIME'],
  });
});

test('沒有必要 obligation 時採 fail-closed', () => {
  const result = evaluateCoverage({ obligations: [] });

  assert.deepEqual(result, {
    status: COVERAGE.FAILED,
    blockers: ['COVERAGE_NO_REQUIRED_OBLIGATIONS'],
  });
});

test('COMPLETE obligation 沒有 changed region 時採 fail-closed', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:NO_CHANGED_REGIONS'],
  });
});

test('changed region 缺少來源 identity 時採 fail-closed', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{ ...region, path: '', language: '' }],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:LANGUAGE_MISSING', 'COV-LANG-001:PATH_MISSING'],
  });
});

test('缺少 changedRegions、adapter 或 runtime 時採 fail-closed', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [{ ...region, adapterId: '', runtime: 'wasm' }],
    }, {
      id: 'COV-LANG-002',
      required: true,
      status: 'COMPLETE',
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: [
      'COV-LANG-001:ADAPTER_MISSING',
      'COV-LANG-001:RUNTIME_INVALID',
      'COV-LANG-002:CHANGED_REGIONS_MISSING',
    ],
  });
});

test('拒絕負數、零長度與反向的 changed region', () => {
  const invalidRegions = [
    { ...region, startByte: -1 },
    { ...region, startByte: 10, endByte: 10 },
    { ...region, startByte: 10, endByte: 5 },
  ];

  for (const changedRegion of invalidRegions) {
    const result = evaluateCoverage({
      obligations: [{
        id: 'COV-LANG-001',
        required: true,
        status: 'COMPLETE',
        changedRegions: [changedRegion],
      }],
    });

    assert.deepEqual(result, {
      status: COVERAGE.INCOMPLETE,
      blockers: ['COV-LANG-001:INVALID_REGION'],
    });
  }
});

test('重疊與未排序的 changed region 都必須被拒絕', () => {
  const overlap = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [region, { ...region, startByte: 5, endByte: 15 }],
    }],
  });
  const outOfOrder = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [
        { ...region, startByte: 10, endByte: 20 },
        { ...region, startByte: 0, endByte: 5 },
      ],
    }],
  });

  assert.deepEqual(overlap, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:REGION_OVERLAP'],
  });
  assert.deepEqual(outOfOrder, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-001:REGION_ORDER_INVALID'],
  });
});

test('相鄰但不重疊的 changed region 是合法邊界', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [
        region,
        { ...region, startByte: 10, endByte: 20 },
      ],
    }],
  });

  assert.deepEqual(result, { status: COVERAGE.COMPLETE, blockers: [] });
});

test('必要 obligation 的 PARTIAL_PARSE、UNSUPPORTED、TIMEOUT 與 TRUNCATED 都保留 blocker', () => {
  const statuses = ['PARTIAL_PARSE', 'UNSUPPORTED', 'TIMEOUT', 'TRUNCATED'];

  for (const reasonCode of statuses) {
    const result = evaluateCoverage({
      obligations: [{
        id: 'COV-LANG-001',
        required: true,
        status: 'INCOMPLETE',
        reasonCode,
        changedRegions: [region],
      }],
    });

    assert.deepEqual(result, {
      status: COVERAGE.INCOMPLETE,
      blockers: [`COV-LANG-001:${reasonCode}`],
    }, reasonCode);
  }
});

test('必要 obligation 失敗時回傳 FAILED，沒有 reasonCode 時使用 status', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'FAILED',
      changedRegions: [],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.FAILED,
    blockers: ['COV-LANG-001:FAILED'],
  });
});

test('多筆必要 obligation 任一筆不完整就不能回傳 COMPLETE', () => {
  const result = evaluateCoverage({
    obligations: [{
      id: 'COV-LANG-001',
      required: true,
      status: 'COMPLETE',
      changedRegions: [region],
    }, {
      id: 'COV-LANG-002',
      required: true,
      status: 'INCOMPLETE',
      reasonCode: 'PARTIAL_PARSE',
      changedRegions: [region],
    }, {
      id: 'COV-LANG-003',
      required: false,
      status: 'INCOMPLETE',
      reasonCode: 'UNSUPPORTED',
      changedRegions: [],
    }],
  });

  assert.deepEqual(result, {
    status: COVERAGE.INCOMPLETE,
    blockers: ['COV-LANG-002:PARTIAL_PARSE'],
  });
});

test('缺少 report、重複 id 與未知 required status 都採 fail-closed', () => {
  const missing = evaluateCoverage();
  const duplicate = evaluateCoverage({
    obligations: [
      { id: 'COV-1', required: true, status: 'COMPLETE', changedRegions: [] },
      { id: 'COV-1', required: true, status: 'COMPLETE', changedRegions: [] },
    ],
  });
  const unknown = evaluateCoverage({
    obligations: [{ id: 'COV-1', required: true, status: 'UNKNOWN', changedRegions: [] }],
  });

  assert.deepEqual(missing, { status: COVERAGE.FAILED, blockers: ['COVERAGE_MISSING'] });
  assert.deepEqual(duplicate, {
    status: COVERAGE.FAILED,
    blockers: ['COVERAGE_DUPLICATE_OBLIGATION'],
  });
  assert.deepEqual(unknown, {
    status: COVERAGE.FAILED,
    blockers: ['COV-1:STATUS_INVALID'],
  });
});
