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

const identityFields = [
  'repository',
  'baseSha',
  'headSha',
  'policyId',
  'policyVersion',
  'runnerVersion',
];

export function stableStrings(values = []) {
  return [...new Set(values)].sort();
}

export function sameIdentity(left, right) {
  return identityFields.every((field) => left?.[field] === right?.[field]);
}

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

function validateEligibility(eligibility, errors) {
  if (!eligibility) return;

  const blockers = eligibility.blockingSources;
  if (!Array.isArray(blockers)) {
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

export function validateAnalysisInput(input) {
  const errors = [];
  validateIdentity(input?.identity, errors);
  validateCoverage(input?.coverage, errors);
  validateEligibility(input?.eligibility, errors);

  return {
    valid: errors.length === 0,
    errors: stableStrings(errors),
  };
}
