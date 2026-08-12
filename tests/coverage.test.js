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
