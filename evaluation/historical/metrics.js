function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 計算單一 Historical PR case 的 file-level review reduction 與 human concern recall。
 *
 * @param {object[]} fileResults - pipeline file results。
 * @param {object[]} humanConcerns - post-analysis ground truth。
 * @returns {object} case metrics。
 */
export function calculateHistoricalMetrics(fileResults, humanConcerns) {
  const selected = fileResults.filter(
    (item) => item.decisionStatus === 'HUMAN_REVIEW_REQUIRED',
  );
  const selectedPaths = new Set(selected.map((item) => item.path));
  const coveredConcerns = humanConcerns.filter(
    (concern) => selectedPaths.has(concern.path),
  );
  const missedConcerns = humanConcerns.filter(
    (concern) => !selectedPaths.has(concern.path),
  );
  const failures = fileResults.filter(
    (item) => item.analysisStatus === 'ANALYSIS_FAILED',
  );
  const fullReview = selected.filter((item) => item.fallback === 'FULL');

  return {
    changedFilesTotal: fileResults.length,
    selectedFilesTotal: selected.length,
    reviewScopeReduction: ratio(
      fileResults.length - selected.length,
      fileResults.length,
    ),
    humanConcernTotal: humanConcerns.length,
    humanConcernCovered: coveredConcerns.length,
    humanConcernMissed: missedConcerns.length,
    humanConcernRecall: ratio(coveredConcerns.length, humanConcerns.length),
    missedConcernIds: missedConcerns.map((item) => item.id).sort(),
    analysisFailureFiles: failures.length,
    analysisFailureRate: ratio(failures.length, fileResults.length),
    fullReviewFiles: fullReview.length,
    fullReviewRate: ratio(fullReview.length, fileResults.length),
  };
}

/**
 * 聚合多個 Historical PR case。
 *
 * @param {object[]} cases - case evaluation results。
 * @returns {object} aggregate metrics。
 */
export function aggregateHistoricalMetrics(cases) {
  const totals = cases.reduce((acc, item) => {
    acc.changed += item.metrics.changedFilesTotal;
    acc.selected += item.metrics.selectedFilesTotal;
    acc.concerns += item.metrics.humanConcernTotal;
    acc.covered += item.metrics.humanConcernCovered;
    acc.missed += item.metrics.humanConcernMissed;
    acc.failures += item.metrics.analysisFailureFiles;
    acc.full += item.metrics.fullReviewFiles;
    return acc;
  }, {
    changed: 0,
    selected: 0,
    concerns: 0,
    covered: 0,
    missed: 0,
    failures: 0,
    full: 0,
  });

  return {
    caseTotal: cases.length,
    changedFilesTotal: totals.changed,
    selectedFilesTotal: totals.selected,
    reviewScopeReduction: ratio(totals.changed - totals.selected, totals.changed),
    humanConcernTotal: totals.concerns,
    humanConcernCovered: totals.covered,
    humanConcernMissed: totals.missed,
    humanConcernRecall: ratio(totals.covered, totals.concerns),
    analysisFailureFiles: totals.failures,
    analysisFailureRate: ratio(totals.failures, totals.changed),
    fullReviewFiles: totals.full,
    fullReviewRate: ratio(totals.full, totals.changed),
  };
}

/**
 * Historical evaluation safety gate。
 *
 * @param {object[]} cases - evaluated cases。
 * @returns {string[]} stable failure codes。
 */
export function validateHistoricalEvaluation(cases) {
  const failures=[];

  for (const item of cases) {
    for (const file of item.files) {
      if (file.publicationAccepted !== true) {
        failures.push(`HISTORICAL_PUBLICATION_FAILED:${item.id}:${file.path}`);
      }
    }
    for (const concernId of item.metrics.missedConcernIds) {
      failures.push(`HISTORICAL_CONCERN_MISSED:${item.id}:${concernId}`);
    }
  }

  return [...new Set(failures)].sort();
}
