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

test('returns COMPLETE when every required obligation is complete', () => {
  const result = evaluateCoverage({
    obligations: [{ id: 'COV-LANG-001', required: true, status: 'COMPLETE', changedRegions: [region] }],
  });

  assert.deepEqual(result, { status: COVERAGE.COMPLETE, blockers: [] });
});

test('keeps PARTIAL_PARSE as a reduction blocker', () => {
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

test('blocks an unknown runtime in a changed region', () => {
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

test('fails closed when no required obligation exists', () => {
  const result = evaluateCoverage({ obligations: [] });

  assert.deepEqual(result, {
    status: COVERAGE.FAILED,
    blockers: ['COVERAGE_NO_REQUIRED_OBLIGATIONS'],
  });
});
