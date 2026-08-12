import { COVERAGE, DECISION, ELIGIBILITY, stableStrings } from './contracts.js';

export function evaluateEligibility({ coverage, riskBlockers = [], analysisError } = {}) {
  const coverageBlockers = stableStrings(coverage?.blockers ?? []);
  const blockers = stableStrings([...coverageBlockers, ...riskBlockers]);

  if (analysisError || !coverage || coverage.status === COVERAGE.FAILED) {
    return {
      status: ELIGIBILITY.ANALYSIS_FAILED,
      blockingSources: stableStrings([...blockers, analysisError].filter(Boolean)),
    };
  }

  if (coverage.status !== COVERAGE.COMPLETE || blockers.length > 0) {
    return {
      status: ELIGIBILITY.NOT_ELIGIBLE,
      blockingSources: blockers.length > 0 ? blockers : ['COVERAGE_NOT_COMPLETE'],
    };
  }

  return { status: ELIGIBILITY.ELIGIBLE, blockingSources: [] };
}

export function reduceReviewScope({ eligibility, policyRequirements = [], audit = false } = {}) {
  if (!eligibility || !Object.values(ELIGIBILITY).includes(eligibility.status)) {
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBILITY_MISSING'],
    };
  }

  const reasons = stableStrings(eligibility.blockingSources ?? []);

  if (eligibility.status === ELIGIBILITY.ELIGIBLE && reasons.length > 0) {
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: stableStrings(['ELIGIBLE_WITH_BLOCKERS', ...reasons]),
    };
  }

  if (
    [ELIGIBILITY.NOT_ELIGIBLE, ELIGIBILITY.ANALYSIS_FAILED].includes(eligibility.status)
    && reasons.length === 0
  ) {
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons: ['ELIGIBILITY_BLOCKER_MISSING'],
    };
  }

  if (eligibility.status === ELIGIBILITY.ANALYSIS_FAILED) {
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'FULL',
      reasons,
    };
  }

  if (eligibility.status === ELIGIBILITY.NOT_ELIGIBLE) {
    const fullReview = reasons.some((reason) =>
      reason.startsWith('COV-') || reason.startsWith('COVERAGE_') || reason.startsWith('ANALYZER_'));
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: fullReview ? 'FULL' : 'TARGETED',
      reasons,
    };
  }

  const requirements = stableStrings([
    ...policyRequirements,
    ...(audit ? ['AUDIT_SAMPLE'] : []),
  ]);
  if (requirements.length > 0) {
    return {
      status: DECISION.HUMAN_REVIEW_REQUIRED,
      fallback: 'TARGETED',
      reasons: requirements,
    };
  }

  return {
    status: DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW,
    reasons: ['NO_REDUCTION_BLOCKER'],
  };
}
