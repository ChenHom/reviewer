import { DECISION, ELIGIBILITY, COVERAGE, validateAnalysisInput } from './contracts.js';
import { evaluateCoverage } from './coverage.js';
import { evaluateEligibility, reduceReviewScope } from './reducer.js';
import {
  createAuthorityState,
  publishCandidate,
  publishCandidateToStore,
} from './publication.js';
import { buildSummary, deriveCheckState, publishSummary } from './summary.js';
import { validateAdapterResult, validateAnalysisContextBinding } from './adapters/contracts.js';
import { normalizeAdapterResult } from './adapters/normalize.js';
import { runAdapter } from './adapters/runner.js';
import { validateEvidence } from './evidence.js';
import { evaluateImpact } from './impact.js';
import { mapInvariants } from './invariants.js';
import { publishGithubResult } from './integrations/github/publisher.js';
import { interpretSemanticFacts } from './facts/interpreter.js';

/**
 * 評估 optional fact layers，將 unresolved facts 統一轉為 reducer blockers。
 *
 * @param {object} input - normalized analysis input。
 * @returns {{blockers: string[], evidence?: object, impact?: object, invariants?: object}} fact layer result。
 */
function evaluateFactLayers(input) {
  const result = { blockers: [] };

  if (input.evidence !== undefined) {
    result.evidence = validateEvidence(input.evidence ?? {});
    result.blockers.push(...result.evidence.blockers);
  }
  if (input.impact !== undefined) {
    result.impact = evaluateImpact(input.impact ?? {});
    result.blockers.push(...result.impact.blockers);
  }
  if (input.invariants !== undefined) {
    result.invariants = mapInvariants(input.invariants ?? {});
    result.blockers.push(...result.invariants.blockers);
  }

  return {
    ...result,
    blockers: [...new Set(result.blockers)].sort(),
  };
}

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
  const inputErrors = [...new Set([...inputValidation.errors, ...contextValidation.errors])].sort();
  const errors = inputErrors.length > 0
    ? [...new Set([
      ...inputErrors,
      ...(typeof input.analysisError === 'string' ? [input.analysisError] : []),
    ])].sort()
    : [];
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

  const factLayers = evaluateFactLayers(input);
  const coverage = evaluateCoverage(input.coverage);
  const eligibility = evaluateEligibility({
    coverage,
    riskBlockers: [...(input.riskBlockers ?? []), ...factLayers.blockers],
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
    ...(Object.keys(factLayers).length > 1 ? { factLayers } : {}),
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
 * 執行以 persisted authority store 為 publication boundary 的 Safety MVP pipeline。
 *
 * @param {object} [input={}] - normalized analysis input。
 * @param {{compareAndSwapCurrent: function, readCurrentHead: function}} store - authority store。
 * @param {{succeed?: boolean}} [summaryOptions={}] - Summary publication 選項。
 * @returns {Promise<{candidate: object, publication: object, summary: object|null, check: object}>} pipeline 結果。
 */
export async function runStoredSafetyMvp(input = {}, store, summaryOptions = {}) {
  const candidate = runAnalysis(input);
  const publication = publishCandidateToStore(store, candidate);

  if (!publication.accepted) {
    return {
      candidate,
      publication,
      summary: null,
      check: { state: 'FAILURE', reason: publication.reason },
    };
  }

  const authoritativeCandidate = publication.current;
  const summary = publishSummary(buildSummary(authoritativeCandidate), summaryOptions);
  const currentIdentity = await store.readCurrentHead(authoritativeCandidate.identity.repository);
  const check = deriveCheckState({
    candidate: authoritativeCandidate,
    summary,
    currentIdentity,
  });

  return {
    candidate: authoritativeCandidate,
    publication,
    summary,
    check,
  };
}

/**
 * 先完成 persisted authority 與安全 Summary/check，再以 sink-only 邊界發布 GitHub 結果。
 *
 * @param {object} [input={}] - normalized analysis input。
 * @param {{compareAndSwapCurrent: function, readCurrentHead: function}} store - authority store。
 * @param {{upsertSummary: function, upsertCheck: function}} transport - provider-neutral GitHub transport。
 * @param {{succeed?: boolean}} [summaryOptions={}] - Summary publication 選項。
 * @returns {Promise<{candidate: object, publication: object, summary: object|null, check: object, delivery: object|null}>} pipeline 與 delivery 結果。
 */
export async function runStoredSafetyMvpWithGithub(
  input = {},
  store,
  transport,
  summaryOptions = {},
) {
  const result = await runStoredSafetyMvp(input, store, summaryOptions);
  if (!result.summary?.published) return { ...result, delivery: null };

  const delivery = await publishGithubResult(transport, {
    repository: result.candidate.identity.repository,
    headSha: result.candidate.identity.headSha,
    candidateDigest: result.summary.summary.candidateDigest,
    summary: result.summary.summary,
    check: result.check,
  });

  return { ...result, delivery };
}

/**
 * 將 AdapterResult 依序完成 validation、normalization 與 semantic fact interpretation。
 * Adapter 只能提供 facts；是否形成 blocker 由受信任 interpreter 決定。
 *
 * @param {object} result - 含 identity 與 AdapterResult 的輸入，或 raw AdapterResult。
 * @param {{valid: boolean, errors: string[]}} validation - AdapterResult validation。
 * @param {function[]} [factInterpreters=[]] - 受信任 semantic fact interpreters。
 * @returns {object} 可交給 Safety MVP 的 normalized input。
 */
function prepareAdapterAnalysisInput(result, validation, factInterpreters = []) {
  const normalized = normalizeAdapterResult(result, validation);
  if (normalized.analysisError) return normalized;

  const factAssessment = interpretSemanticFacts(
    normalized.semanticFacts ?? [],
    factInterpreters,
    {
      identity: normalized.identity,
      contextBinding: normalized.contextBinding,
    },
  );

  return {
    ...normalized,
    riskBlockers: [...new Set([
      ...(normalized.riskBlockers ?? []),
      ...factAssessment.blockers,
    ])].sort(),
    factAssessment,
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
export function runNormalizedAdapterResult(
  result,
  authorityState,
  summaryOptions = {},
  factInterpreters = [],
) {
  const adapterResult = result?.adapterResult ?? result;
  const validation = validateAdapterResult(adapterResult);
  return runSafetyMvp(
    prepareAdapterAnalysisInput(result, validation, factInterpreters),
    authorityState,
    summaryOptions,
  );
}

/**
 * 建立不進入 authoritative publication 的 Adapter execution failure pipeline result。
 *
 * @param {object} failureInput - 含 identity 與 stable analysisError 的 failure input。
 * @param {string} failureCode - stable execution failure code。
 * @returns {{candidate: object, publication: object, summary: null, check: object}} failure pipeline result。
 */
function createAdapterFailurePipelineResult(failureInput, failureCode) {
  return {
    candidate: runAnalysis(failureInput),
    publication: { accepted: false, reason: failureCode },
    summary: null,
    check: { state: 'FAILURE', reason: failureCode },
  };
}

/**
 * 執行 Adapter、驗證結果、正規化 facts，再交由 Safety MVP pipeline 決定。
 *
 * @param {{analyze: function}} adapter - injected Adapter implementation。
 * @param {object} [request={}] - Adapter request，至少可包含 identity。
 * @param {{currentHead: object, currentContextBinding?: object, current: object|null}} [authorityState] - authority state。
 * @param {{signal?: AbortSignal, timeoutMs?: number, succeed?: boolean}} [options={}] - execution 與 Summary options。
 * @returns {Promise<{candidate: object, publication: object, summary: object|null, check: object}>} pipeline 結果。
 */
export async function runAdapterPipeline(
  adapter,
  request = {},
  authorityState,
  options = {},
) {
  const execution = await runAdapter(adapter, request, options);
  if (!execution.ok) {
    return createAdapterFailurePipelineResult(execution.input, execution.code);
  }

  const input = {
    identity: execution.identity,
    adapterResult: execution.adapterResult,
  };
  const validation = validateAdapterResult(execution.adapterResult);
  if (!validation.valid) {
    const failureInput = {
      identity: execution.identity,
      analysisError: 'ADAPTER_RESULT_INVALID',
      diagnostics: ['ADAPTER_RESULT_INVALID'],
    };
    return createAdapterFailurePipelineResult(failureInput, 'ADAPTER_RESULT_INVALID');
  }

  return runSafetyMvp(
    prepareAdapterAnalysisInput(input, validation, options.factInterpreters ?? []),
    authorityState,
    options,
  );
}

/**
 * 執行 Adapter、normalization、persisted CAS 與 optional GitHub sink 的完整 pipeline。
 *
 * @param {{analyze: function}} adapter - injected Adapter implementation。
 * @param {object} [request={}] - Adapter request，至少可包含 identity。
 * @param {{compareAndSwapCurrent: function, readCurrentHead: function}} store - authority store。
 * @param {{upsertSummary: function, upsertCheck: function}|undefined} [transport] - optional GitHub transport。
 * @param {{signal?: AbortSignal, timeoutMs?: number, succeed?: boolean}} [options={}] - execution 與 Summary options。
 * @returns {Promise<object>} 完整 pipeline 與 delivery 結果。
 */
export async function runStoredAdapterPipeline(
  adapter,
  request = {},
  store,
  transport,
  options = {},
) {
  const execution = await runAdapter(adapter, request, options);
  if (!execution.ok) {
    return createAdapterFailurePipelineResult(execution.input, execution.code);
  }

  const input = {
    identity: execution.identity,
    adapterResult: execution.adapterResult,
  };
  const validation = validateAdapterResult(execution.adapterResult);
  if (!validation.valid) {
    return createAdapterFailurePipelineResult({
      identity: execution.identity,
      analysisError: 'ADAPTER_RESULT_INVALID',
      diagnostics: ['ADAPTER_RESULT_INVALID'],
    }, 'ADAPTER_RESULT_INVALID');
  }

  const normalized = prepareAdapterAnalysisInput(
    input,
    validation,
    options.factInterpreters ?? [],
  );
  return transport
    ? runStoredSafetyMvpWithGithub(normalized, store, transport, options)
    : runStoredSafetyMvp(normalized, store, options);
}
