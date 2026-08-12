import { DECISION, ELIGIBILITY, COVERAGE, validateAnalysisInput } from './contracts.js';
import { evaluateCoverage } from './coverage.js';
import { evaluateEligibility, reduceReviewScope } from './reducer.js';
import { createAuthorityState, publishCandidate } from './publication.js';
import { buildSummary, deriveCheckState, publishSummary } from './summary.js';

/**
 * 執行 normalized input 的 deterministic analysis、coverage、eligibility 與 reduction。
 *
 * @param {object} [input={}] - normalized analysis input。
 * @returns {object} 可供 publication 驗證的 analysis candidate。
 */
export function runAnalysis(input = {}) {
  const inputValidation = validateAnalysisInput(input);
  if (!inputValidation.valid) {
    const eligibility = {
      status: ELIGIBILITY.ANALYSIS_FAILED,
      blockingSources: inputValidation.errors,
    };
    return {
      identity: input.identity ?? null,
      analysisStatus: 'ANALYSIS_FAILED',
      coverage: { status: COVERAGE.FAILED, blockers: inputValidation.errors },
      eligibility,
      decision: {
        status: DECISION.HUMAN_REVIEW_REQUIRED,
        fallback: 'FULL',
        reasons: inputValidation.errors,
      },
      errors: inputValidation.errors,
    };
  }

  const coverage = evaluateCoverage(input.coverage);
  const eligibility = evaluateEligibility({
    coverage,
    riskBlockers: input.riskBlockers,
    analysisError: input.analysisError,
  });
  const decision = reduceReviewScope({
    eligibility,
    policyRequirements: input.policyRequirements,
    audit: input.audit,
  });

  return {
    identity: input.identity,
    analysisStatus: eligibility.status === ELIGIBILITY.ANALYSIS_FAILED ? 'ANALYSIS_FAILED' : 'COMPLETE',
    coverage,
    eligibility,
    decision,
    errors: [],
  };
}

/**
 * 執行完整 Safety MVP pipeline，直到 authoritative Summary 與 status check。
 *
 * @param {object} [input={}] - normalized analysis input。
 * @param {{currentHead: object, current: object|null}} [authorityState] - authority state。
 * @param {{succeed?: boolean}} [summaryOptions={}] - Summary publication 選項。
 * @returns {{candidate: object, publication: object, summary: object|null, check: object}} pipeline 結果。
 */
export function runSafetyMvp(input = {}, authorityState = createAuthorityState(input.identity), summaryOptions = {}) {
  const candidate = runAnalysis(input);
  const publication = publishCandidate(authorityState, candidate);

  if (!publication.accepted) {
    return {
      candidate,
      publication,
      summary: null,
      check: { state: 'FAILURE', reason: publication.reason },
    };
  }

  const summary = publishSummary(buildSummary(publication.current), summaryOptions);
  const check = deriveCheckState({
    candidate: publication.current,
    summary,
    currentIdentity: authorityState.currentHead,
  });

  return {
    candidate: publication.current,
    publication,
    summary,
    check,
  };
}
