import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ONE_WAY_DOORS, TRACK, routeFile, summarizeTracks } from '../src/routing.js';
import { formatReview } from '../src/review/format.js';

const HUMAN = 'HUMAN_REVIEW_REQUIRED';
const NOT_SELECTED = 'NOT_SELECTED_FOR_HUMAN_REVIEW';

const file = (fallback, reasons, path = 'app/A.php') => ({ path, decision: HUMAN, fallback, reasons });

test('NOT_SELECTED 為 AUTO_PASS', () => {
  assert.deepEqual(routeFile({ path: 'a.php', decision: NOT_SELECTED, fallback: null, reasons: ['NO_REDUCTION_BLOCKER'] }), {
    track: TRACK.AUTO_PASS, oneWayDoors: [],
  });
});

test('TARGETED 且沒有單向門時為 AI_TRACK；有單向門時為 ESCALATED', () => {
  assert.equal(routeFile(file('TARGETED', ['COMPARISON_OPERATOR_CHANGED', 'FACT_UNHANDLED:php-1'])).track, TRACK.AI_TRACK);
  assert.equal(routeFile(file('TARGETED', ['FILE_RENAMED'])).track, TRACK.AI_TRACK);
  assert.deepEqual(routeFile(file('TARGETED', ['FACT_UNHANDLED:php-1', 'TRANSACTION_BOUNDARY_REMOVED'])), {
    track: TRACK.ESCALATED, oneWayDoors: ['TRANSACTION_BOUNDARY_REMOVED'],
  });
  for (const door of DEFAULT_ONE_WAY_DOORS) {
    assert.equal(routeFile(file('TARGETED', [door])).track, TRACK.ESCALATED, door);
  }
});

test('專案可以加入單向門', () => {
  const options = { oneWayDoors: [...DEFAULT_ONE_WAY_DOORS, 'CONSTANT_VALUE_CHANGED'] };
  assert.equal(routeFile(file('TARGETED', ['CONSTANT_VALUE_CHANGED']), options).track, TRACK.ESCALATED);
  assert.equal(routeFile(file('TARGETED', ['CONSTANT_VALUE_CHANGED'])).track, TRACK.AI_TRACK);
});

test('FULL 預設為 ESCALATED；只有沒有分析的檔案能被 aiTrackPath 交給 AI', () => {
  const aiTrackPath = (path) => path.startsWith('tests/');
  assert.equal(routeFile(file('FULL', ['COV-PHP-001:UNRECOGNIZED_PHP_CHANGE'])).track, TRACK.ESCALATED);
  assert.equal(routeFile(file('FULL', ['UNSUPPORTED_FILE_TYPE'], 'tests/a.md')).track, TRACK.ESCALATED);
  assert.equal(routeFile(file('FULL', ['UNSUPPORTED_FILE_TYPE'], 'tests/a.md'), { aiTrackPath }).track, TRACK.AI_TRACK);
  assert.equal(routeFile(file('FULL', ['FILE_ADDED'], 'tests/B.php'), { aiTrackPath }).track, TRACK.AI_TRACK);
  assert.equal(routeFile(file('FULL', ['FILE_DELETED'], 'tests/B.php'), { aiTrackPath }).track, TRACK.AI_TRACK);
  // 分析失敗、binary、symlink、submodule、單向門不受 aiTrackPath 影響
  for (const reasons of [
    ['COV-PHP-001:UNRECOGNIZED_PHP_CHANGE'],
    ['ANALYZER_ERROR:boom'],
    ['BINARY_FILE'],
    ['SYMLINK_CHANGED'],
    ['SUBMODULE_CHANGED'],
    ['UNSUPPORTED_FILE_TYPE', 'PROTECTED_PATH'],
    [],
  ]) {
    assert.equal(routeFile(file('FULL', reasons, 'tests/a.php'), { aiTrackPath }).track, TRACK.ESCALATED, reasons.join());
  }
  assert.equal(routeFile(file('FULL', ['UNSUPPORTED_FILE_TYPE'], 'src/a.md'), { aiTrackPath }).track, TRACK.ESCALATED);
});

test('不認得的 decision 或缺少欄位時 fail-closed 為 ESCALATED', () => {
  assert.equal(routeFile({ path: 'a.php', decision: 'SOMETHING', fallback: 'TARGETED', reasons: [] }).track, TRACK.ESCALATED);
  assert.equal(routeFile(undefined).track, TRACK.ESCALATED);
  assert.equal(routeFile({ path: 'a.php', decision: HUMAN }).track, TRACK.ESCALATED);
});

test('PR 路由取最嚴格的檔案路由；不認得的 track 視為 ESCALATED', () => {
  assert.deepEqual(summarizeTracks([]), { track: TRACK.AUTO_PASS, autoPass: 0, aiTrack: 0, escalated: 0 });
  assert.deepEqual(summarizeTracks([{ track: 'AUTO_PASS' }, { track: 'AI_TRACK' }]), {
    track: TRACK.AI_TRACK, autoPass: 1, aiTrack: 1, escalated: 0,
  });
  assert.equal(summarizeTracks([{ track: 'AUTO_PASS' }, { track: 'ESCALATED' }, { track: 'AI_TRACK' }]).track, TRACK.ESCALATED);
  assert.equal(summarizeTracks([{ track: 'AUTO_PASS' }, { track: undefined }]).track, TRACK.ESCALATED);
});

test('文字報表在沒有路由資訊時維持單一「需要 review」區段', () => {
  const report = {
    repository: 'r',
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'HEAD', sha: 'b'.repeat(40) },
    decision: { status: HUMAN, files: 1, targeted: 1, full: 0 },
    files: [{ path: 'a.php', decision: HUMAN, fallback: 'TARGETED', reasons: ['X'], facts: [] }],
  };
  const text = formatReview(report);
  assert.match(text, /需要 review：\n {2}TARGETED a\.php/);
  assert.doesNotMatch(text, /路由：/);
});
