export const COVERAGE = Object.freeze({
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE',
  FAILED: 'FAILED',
});

export const RUNTIMES = Object.freeze([
  'server',
  'client',
  'edge',
  'worker',
  'external',
  'unknown',
]);

export const ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
});

export const DECISION = Object.freeze({
  NOT_SELECTED_FOR_HUMAN_REVIEW: 'NOT_SELECTED_FOR_HUMAN_REVIEW',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED',
});

const analysisStatuses = ['COMPLETE', 'ANALYSIS_FAILED'];

const identityFields = [
  'repository',
  'baseSha',
  'headSha',
  'policyId',
  'policyVersion',
  'runnerVersion',
];

/**
 * 將字串集合去重並排序，產生穩定的 blocker 順序。
 *
 * @param {string[]} [values=[]] - 要正規化的字串集合。
 * @returns {string[]} 去重且排序後的字串集合。
 */
export function stableStrings(values = []) {
  return [...new Set(values)].sort();
}

/**
 * 比較兩個 AnalysisIdentity 是否完全一致。
 *
 * @param {object|undefined} left - 第一個 identity。
 * @param {object|undefined} right - 第二個 identity。
 * @returns {boolean} 兩個 identity 是否完全一致。
 */
export function sameIdentity(left, right) {
  return identityFields.every((field) => left?.[field] === right?.[field]);
}

/**
 * 驗證分析 identity 的必要欄位。
 *
 * @param {object|undefined} identity - 要驗證的 identity。
 * @param {string[]} errors - 累積驗證錯誤的陣列。
 */
function validateIdentity(identity, errors) {
  if (!identity || typeof identity !== 'object') {
    errors.push('IDENTITY_MISSING');
    return;
  }

  for (const field of identityFields) {
    if (typeof identity[field] !== 'string' || identity[field].trim() === '') {
      errors.push(`IDENTITY_${field.toUpperCase()}_MISSING`);
    }
  }
}

/**
 * 驗證 coverage report 的 obligation 結構與狀態。
 *
 * @param {object|undefined} coverage - 要驗證的 coverage report。
 * @param {string[]} errors - 累積驗證錯誤的陣列。
 */
function validateCoverage(coverage, errors) {
  if (!coverage || !Array.isArray(coverage.obligations)) {
    errors.push('COVERAGE_MISSING');
    return;
  }

  const ids = coverage.obligations.map((obligation) => obligation?.id);
  if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
    errors.push('COVERAGE_ID_MISSING');
  }

  if (new Set(ids).size !== ids.length) {
    errors.push('COVERAGE_DUPLICATE_OBLIGATION');
  }

  const required = coverage.obligations.filter((obligation) => obligation?.required === true);
  if (required.length === 0) {
    errors.push('COVERAGE_NO_REQUIRED_OBLIGATIONS');
  }

  for (const obligation of coverage.obligations) {
    if (!Object.values(COVERAGE).includes(obligation?.status)) {
      errors.push(`COVERAGE_STATUS_INVALID:${obligation?.id ?? 'unknown'}`);
    }
  }
}

/**
 * 驗證 eligibility 的 blocker 一致性。
 *
 * @param {object|undefined} eligibility - 要驗證的 eligibility 結果。
 * @param {string[]} errors - 累積驗證錯誤的陣列。
 */
function validateEligibility(eligibility, errors) {
  if (!eligibility) return;

  if (!Object.values(ELIGIBILITY).includes(eligibility.status)) {
    errors.push('ELIGIBILITY_STATUS_INVALID');
  }

  const blockers = eligibility.blockingSources;
  if (
    !Array.isArray(blockers)
    || blockers.some((blocker) => typeof blocker !== 'string' || blocker.trim() === '')
  ) {
    errors.push('ELIGIBILITY_BLOCKERS_INVALID');
    return;
  }

  if (eligibility.status === ELIGIBILITY.ELIGIBLE && blockers.length > 0) {
    errors.push('ELIGIBLE_WITH_BLOCKERS');
  }

  if (
    [ELIGIBILITY.NOT_ELIGIBLE, ELIGIBILITY.ANALYSIS_FAILED].includes(eligibility.status)
    && blockers.length === 0
  ) {
    errors.push(`${eligibility.status}_WITHOUT_BLOCKERS`);
  }
}

/**
 * 驗證可選的字串陣列欄位。
 *
 * @param {unknown} value - 要驗證的欄位值。
 * @param {string} errorCode - 驗證失敗時使用的錯誤碼。
 * @param {string[]} errors - 累積驗證錯誤的陣列。
 */
function validateStringList(value, errorCode, errors) {
  if (value === undefined) return;

  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    errors.push(errorCode);
  }
}

/**
 * 驗證進入 Safety MVP 的 normalized analysis input。
 *
 * @param {object} [input={}] - 要驗證的分析輸入。
 * @returns {{valid: boolean, errors: string[]}} 驗證結果與穩定錯誤碼。
 */
export function validateAnalysisInput(input) {
  const errors = [];
  validateIdentity(input?.identity, errors);
  validateCoverage(input?.coverage, errors);
  validateEligibility(input?.eligibility, errors);
  validateStringList(input?.riskBlockers, 'RISK_BLOCKERS_INVALID', errors);
  validateStringList(input?.policyRequirements, 'POLICY_REQUIREMENTS_INVALID', errors);

  if (input?.audit !== undefined && typeof input.audit !== 'boolean') {
    errors.push('AUDIT_INVALID');
  }

  if (
    input?.analysisError !== undefined
    && (typeof input.analysisError !== 'string' || input.analysisError.trim() === '')
  ) {
    errors.push('ANALYSIS_ERROR_INVALID');
  }

  return {
    valid: errors.length === 0,
    errors: stableStrings(errors),
  };
}

/**
 * 驗證可進入 authoritative publication 的 candidate。
 *
 * @param {object|undefined} candidate - 要驗證的分析 candidate。
 * @returns {{valid: boolean, errors: string[]}} 驗證結果與穩定錯誤碼。
 */
export function validateCandidate(candidate) {
  const errors = [];
  validateIdentity(candidate?.identity, errors);

  if (!analysisStatuses.includes(candidate?.analysisStatus)) {
    errors.push('ANALYSIS_STATUS_INVALID');
  }

  const coverage = candidate?.coverage;
  if (!coverage || !Object.values(COVERAGE).includes(coverage.status)) {
    errors.push('CANDIDATE_COVERAGE_INVALID');
  } else if (
    !Array.isArray(coverage.blockers)
    || coverage.blockers.some((blocker) => typeof blocker !== 'string' || blocker.trim() === '')
  ) {
    errors.push('CANDIDATE_COVERAGE_BLOCKERS_INVALID');
  } else if (coverage.status === COVERAGE.COMPLETE && coverage.blockers.length > 0) {
    errors.push('COMPLETE_WITH_COVERAGE_BLOCKERS');
  } else if (coverage.status !== COVERAGE.COMPLETE && coverage.blockers.length === 0) {
    errors.push('INCOMPLETE_WITHOUT_COVERAGE_BLOCKERS');
  }

  const eligibility = candidate?.eligibility;
  if (!eligibility || !Object.values(ELIGIBILITY).includes(eligibility.status)) {
    errors.push('CANDIDATE_ELIGIBILITY_INVALID');
  } else if (
    !Array.isArray(eligibility.blockingSources)
    || eligibility.blockingSources.some(
      (blocker) => typeof blocker !== 'string' || blocker.trim() === '',
    )
  ) {
    errors.push('CANDIDATE_ELIGIBILITY_BLOCKERS_INVALID');
  }

  const decision = candidate?.decision;
  if (
    !decision
    || !Object.values(DECISION).includes(decision.status)
    || !Array.isArray(decision.reasons)
    || decision.reasons.some((reason) => typeof reason !== 'string' || reason.trim() === '')
    || decision.reasons.length === 0
  ) {
    errors.push('CANDIDATE_DECISION_INVALID');
  }

  if (eligibility && Array.isArray(eligibility.blockingSources)) {
    if (eligibility.status === ELIGIBILITY.ELIGIBLE && eligibility.blockingSources.length > 0) {
      errors.push('ELIGIBLE_WITH_BLOCKERS');
    }

    if (
      [ELIGIBILITY.NOT_ELIGIBLE, ELIGIBILITY.ANALYSIS_FAILED].includes(eligibility.status)
      && eligibility.blockingSources.length === 0
    ) {
      errors.push(`${eligibility.status}_WITHOUT_BLOCKERS`);
    }
  }

  if (candidate?.analysisStatus === 'ANALYSIS_FAILED') {
    if (eligibility?.status !== ELIGIBILITY.ANALYSIS_FAILED) {
      errors.push('ANALYSIS_FAILED_ELIGIBILITY_MISMATCH');
    }
    if (decision?.status !== DECISION.HUMAN_REVIEW_REQUIRED || decision?.fallback !== 'FULL') {
      errors.push('ANALYSIS_FAILED_DECISION_MISMATCH');
    }
  }

  if (candidate?.analysisStatus === 'COMPLETE' && eligibility?.status === ELIGIBILITY.ANALYSIS_FAILED) {
    errors.push('COMPLETE_WITH_ANALYSIS_FAILURE');
  }

  if (
    coverage?.status === COVERAGE.FAILED
    && candidate?.analysisStatus !== 'ANALYSIS_FAILED'
  ) {
    errors.push('COVERAGE_FAILED_WITHOUT_ANALYSIS_FAILURE');
  }

  if (eligibility?.status === ELIGIBILITY.ELIGIBLE && coverage?.status !== COVERAGE.COMPLETE) {
    errors.push('ELIGIBLE_WITH_INCOMPLETE_COVERAGE');
  }

  if (
    eligibility?.status === ELIGIBILITY.NOT_ELIGIBLE
    && decision?.status !== DECISION.HUMAN_REVIEW_REQUIRED
  ) {
    errors.push('NOT_ELIGIBLE_WITHOUT_HUMAN_REVIEW');
  }

  if (decision?.status === DECISION.NOT_SELECTED_FOR_HUMAN_REVIEW) {
    if (eligibility?.status !== ELIGIBILITY.ELIGIBLE) {
      errors.push('NOT_SELECTED_WITHOUT_ELIGIBILITY');
    }
    if (Object.hasOwn(decision, 'fallback')) {
      errors.push('NOT_SELECTED_WITH_FALLBACK');
    }
  }

  if (decision?.status === DECISION.HUMAN_REVIEW_REQUIRED) {
    if (!['TARGETED', 'FULL'].includes(decision.fallback)) {
      errors.push('HUMAN_REVIEW_FALLBACK_INVALID');
    }
  }

  return {
    valid: errors.length === 0,
    errors: stableStrings(errors),
  };
}
