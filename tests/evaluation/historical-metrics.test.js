import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateHistoricalMetrics,
  calculateHistoricalMetrics,
  validateHistoricalEvaluation,
} from '../../evaluation/historical/metrics.js';
import { validateHistoricalManifest } from '../../evaluation/historical/schema.js';

test('historical metrics 分開量測 concern recall 與 review scope reduction', () => {
  const files=[
    {
      path:'a.php',
      publicationAccepted:true,
      analysisStatus:'COMPLETE',
      decisionStatus:'HUMAN_REVIEW_REQUIRED',
      fallback:'TARGETED',
    },
    {
      path:'b.php',
      publicationAccepted:true,
      analysisStatus:'COMPLETE',
      decisionStatus:'NOT_SELECTED_FOR_HUMAN_REVIEW',
      fallback:null,
    },
  ];
  const concerns=[{id:'HC-1',path:'a.php'}];
  const metrics=calculateHistoricalMetrics(files, concerns);

  assert.equal(metrics.humanConcernRecall, 1);
  assert.equal(metrics.reviewScopeReduction, 0.5);
  assert.deepEqual(metrics.missedConcernIds, []);
});

test('human concern 落在未選取檔案時 gate 必須失敗', () => {
  const files=[{
    path:'a.php',
    publicationAccepted:true,
    analysisStatus:'COMPLETE',
    decisionStatus:'NOT_SELECTED_FOR_HUMAN_REVIEW',
    fallback:null,
  }];
  const metrics=calculateHistoricalMetrics(files, [{id:'HC-1',path:'a.php'}]);
  const failures=validateHistoricalEvaluation([{
    id:'HIST-1',
    files,
    metrics,
  }]);

  assert.deepEqual(failures, ['HISTORICAL_CONCERN_MISSED:HIST-1:HC-1']);
});

test('aggregate historical metrics 使用總 concern/file 數而非 case 平均', () => {
  const one={metrics:{
    changedFilesTotal:2,
    selectedFilesTotal:1,
    humanConcernTotal:1,
    humanConcernCovered:1,
    humanConcernMissed:0,
    analysisFailureFiles:0,
    fullReviewFiles:0,
  }};
  const two={metrics:{
    changedFilesTotal:1,
    selectedFilesTotal:1,
    humanConcernTotal:3,
    humanConcernCovered:2,
    humanConcernMissed:1,
    analysisFailureFiles:1,
    fullReviewFiles:1,
  }};
  const aggregate=aggregateHistoricalMetrics([one,two]);

  assert.equal(aggregate.reviewScopeReduction, 1 / 3);
  assert.equal(aggregate.humanConcernRecall, 0.75);
  assert.equal(aggregate.analysisFailureRate, 1 / 3);
});

test('manifest concern path 必須屬於 changed files', () => {
  const validation=validateHistoricalManifest({
    id:'HIST-1',
    repository:'example/repo',
    baseSha:'base',
    headSha:'head',
    sourceType:'historical',
    files:[{path:'a.php',beforeFile:'before.php',afterFile:'after.php'}],
    humanConcerns:[{id:'HC-1',path:'b.php'}],
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('HISTORICAL_CONCERN_PATH_UNKNOWN:HC-1'));
});
