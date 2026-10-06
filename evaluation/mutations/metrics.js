/**
 * 安全計算比例；沒有分母時回傳 null，避免虛構 100%。
 *
 * @param {number} numerator - 分子。
 * @param {number} denominator - 分母。
 * @returns {number|null} 0..1 比例。
 */
function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 從 mutation evaluation case results 計算安全與 reduction 指標。
 *
 * Critical Recall 只回答「關鍵 mutation 是否仍要求 Human Review」。
 * criticalDirectFactCoverage 另外回答「其中多少是 analyzer 直接產生 semantic fact」，
 * 避免把純 fail-closed fallback 誤當成 semantic detection 能力。
 *
 * @param {object[]} results - mutation case execution results。
 * @returns {object} deterministic evaluation metrics。
 */
export function calculateMutationMetrics(results) {
  const critical = results.filter((item) => item.classification === 'critical');
  const safe = results.filter((item) => item.classification === 'safe');

  const criticalCaught = critical.filter(
    (item) => item.decisionStatus === 'HUMAN_REVIEW_REQUIRED',
  );
  const criticalFalseNegatives = critical.filter(
    (item) => item.decisionStatus === 'NOT_SELECTED_FOR_HUMAN_REVIEW',
  );
  const criticalDirectFact = critical.filter(
    (item) => Array.isArray(item.factKinds) && item.factKinds.length > 0,
  );
  const criticalFallbackOnly = criticalCaught.filter(
    (item) => !Array.isArray(item.factKinds) || item.factKinds.length === 0,
  );

  const safeReduced = safe.filter(
    (item) => item.decisionStatus === 'NOT_SELECTED_FOR_HUMAN_REVIEW',
  );
  const safeHeld = safe.filter(
    (item) => item.decisionStatus === 'HUMAN_REVIEW_REQUIRED',
  );

  const partialCoverage = results.filter(
    (item) => item.coverageStatus !== 'COMPLETE',
  );
  const analysisFailures = results.filter(
    (item) => item.analysisStatus === 'ANALYSIS_FAILED',
  );
  const fullReviewFallbacks = results.filter(
    (item) => item.fallback === 'FULL',
  );

  return {
    totalCases: results.length,
    criticalTotal: critical.length,
    criticalCaught: criticalCaught.length,
    criticalFalseNegatives: criticalFalseNegatives.length,
    criticalRecall: ratio(criticalCaught.length, critical.length),
    falseNegativeRate: ratio(criticalFalseNegatives.length, critical.length),
    criticalDirectFactCount: criticalDirectFact.length,
    criticalDirectFactCoverage: ratio(criticalDirectFact.length, critical.length),
    criticalFallbackOnlyCount: criticalFallbackOnly.length,
    safeTotal: safe.length,
    safeReduced: safeReduced.length,
    safeHeld: safeHeld.length,
    safeReductionRate: ratio(safeReduced.length, safe.length),
    partialCoverageCount: partialCoverage.length,
    partialCoverageRate: ratio(partialCoverage.length, results.length),
    analysisFailureCount: analysisFailures.length,
    analysisFailureRate: ratio(analysisFailures.length, results.length),
    fullReviewFallbackCount: fullReviewFallbacks.length,
    fullReviewFallbackRate: ratio(fullReviewFallbacks.length, results.length),
  };
}

/**
 * 驗證目前 benchmark 的 regression 與 safety gate。
 *
 * Safe case 被保守留下 Human Review 不視為安全失敗，但 expectedCurrentDecision
 * 仍用來固定目前行為，避免未經意的 evaluator 漂移。
 *
 * @param {object[]} results - mutation case execution results。
 * @returns {string[]} stable failure codes。
 */
export function validateMutationEvaluation(results) {
  const failures = [];

  for (const result of results) {
    if (result.publicationAccepted !== true) {
      failures.push(`PIPELINE_PUBLICATION_FAILED:${result.id}`);
    }

    if (result.decisionStatus !== result.expectedCurrentDecision) {
      failures.push(`DECISION_REGRESSION:${result.id}`);
    }

    if (
      result.classification === 'critical'
      && result.decisionStatus !== 'HUMAN_REVIEW_REQUIRED'
    ) {
      failures.push(`CRITICAL_FALSE_NEGATIVE:${result.id}`);
    }

    for (const expectedKind of result.expectedFactKinds ?? []) {
      if (!result.factKinds.includes(expectedKind)) {
        failures.push(`EXPECTED_FACT_MISSING:${result.id}:${expectedKind}`);
      }
    }

    for (const expectedReason of result.expectedReasons ?? []) {
      if (!(result.reasons ?? []).includes(expectedReason)) {
        failures.push(`EXPECTED_REASON_MISSING:${result.id}:${expectedReason}`);
      }
    }
  }

  return [...new Set(failures)].sort();
}
