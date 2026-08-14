import { DECISION, ELIGIBILITY, COVERAGE, validateAnalysisInput } from './contracts.js';
import { evaluateCoverage } from './coverage.js';
import { evaluateEligibility, reduceReviewScope } from './reducer.js';
import { createAuthorityState, publishCandidate } from './publication.js';
import { buildSummary, deriveCheckState, publishSummary } from './summary.js';
import { validateAdapterResult, validateAnalysisContextBinding } from './adapters/contracts.js';
import { normalizeAdapterResult } from './adapters/normalize.js';

/**
 * 執行 normalized input 的 deterministic analysis、coverage、eligibility 與 reduction。
 *
 * @param {object} [input={}] - normalized analysis input。
 * @returns {object} 可供 publication 驗證的 analysis candidate。
 */
export function runAnalysis(input = {}) {
  const inputValidation = validateAnalysisInput(input);
  const contextValidation = input.contextBinding
    ? validateAnalysisContextBinding(input.contextBinding)
    : { valid: true, errors: [] };
  const errors = [...new Set([...inputValidation.errors, ...contextValidation.errors])].sort();
  if (errors.length > 0) {
    const eligibility = {
      status: ELIGIBILITY.ANALYSIS_FAILED,
      blockingSources: errors,
    };
    return {
      identity: input.identity ?? null,
      contextBinding: input.contextBinding,
      analysisStatus: 'ANALYSIS_FAILED',
      coverage: { status: COVERAGE.FAILED, blockers: errors },
      eligibility,
      decision: {
        status: DECISION.HUMAN_REVIEW_REQUIRED,
        fallback: 'FULL',
        reasons: errors,
      },
      errors,
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
    contextBinding: input.contextBinding,
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
export function runSafetyMvp(
  input = {},
  authorityState = createAuthorityState(input.identity, input.contextBinding),
  summaryOptions = {},
) {
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

/**
 * 驗證 AdapterResult、正規化 facts，並交由既有 Safety MVP runner 決定。
 *
 * @param {object} result - 含 identity 與 AdapterResult 的輸入，或 raw AdapterResult。
 * @param {{currentHead: object, currentContextBinding?: object, current: object|null}} [authorityState] - authority state。
 * @param {{succeed?: boolean}} [summaryOptions={}] - Summary publication 選項。
 * @returns {{candidate: object, publication: object, summary: object|null, check: object}} pipeline 結果。
 */
export function runNormalizedAdapterResult(result, authorityState, summaryOptions = {}) {
  const adapterResult = result?.adapterResult ?? result;
  const validation = validateAdapterResult(adapterResult);
  return runSafetyMvp(
    normalizeAdapterResult(result, validation),
    authorityState,
    summaryOptions,
  );
}
