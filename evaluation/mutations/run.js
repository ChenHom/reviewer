import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import { createAnalysisContextBinding } from '../../src/adapters/contracts.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';
import { PHP_LARAVEL_DOMAIN_INTERPRETERS } from '../../src/interpreters/php-laravel-domain.js';
import { createAuthorityState } from '../../src/publication.js';
import { runAdapterPipeline } from '../../src/runner.js';
import {
  calculateMutationMetrics,
  validateMutationEvaluation,
} from './metrics.js';

const adapter = createPhpLaravelAdapter();

/**
 * 讀取 JSON 檔。
 *
 * @param {URL} url - JSON file URL。
 * @returns {Promise<unknown>} parsed JSON。
 */
async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * 讀取 mutation fixture source。
 *
 * @param {string} fixture - fixture directory name。
 * @param {'before'|'after'} side - source side。
 * @returns {Promise<string>} PHP source。
 */
async function readFixture(fixture, side) {
  return readFile(
    new URL(
      `../../fixtures/php-laravel/${fixture}/${side}.php`,
      import.meta.url,
    ),
    'utf8',
  );
}

/**
 * 建立每個 evaluation case 專屬 identity，避免 authority state 互相污染。
 *
 * @param {string} id - evaluation case id。
 * @returns {object} AnalysisIdentity。
 */
function identityFor(id) {
  return {
    repository: 'evaluation/php-laravel',
    baseSha: `base-${id.toLowerCase()}`,
    headSha: `head-${id.toLowerCase()}`,
    policyId: 'mutation-evaluation',
    policyVersion: '1',
    runnerVersion: '1',
  };
}

/**
 * 執行單一 mutation case。
 *
 * @param {object} definition - case definition。
 * @returns {Promise<object>} normalized evaluation result。
 */
async function executeCase(definition) {
  const [beforeSource, afterSource] = await Promise.all([
    readFixture(definition.fixture, 'before'),
    readFixture(definition.fixture, 'after'),
  ]);

  const identity = identityFor(definition.id);
  const request = {
    identity,
    path: definition.path,
    beforeSource,
    afterSource,
  };
  const adapterResult = await adapter.analyze(request);
  const authorityState = createAuthorityState(
    identity,
    createAnalysisContextBinding(
      adapterResult,
      PHP_LARAVEL_DOMAIN_INTERPRETERS,
    ),
  );
  const pipeline = await runAdapterPipeline(
    adapter,
    request,
    authorityState,
    {
      timeoutMs: 2_000,
      factInterpreters: PHP_LARAVEL_DOMAIN_INTERPRETERS,
    },
  );

  return {
    ...definition,
    publicationAccepted: pipeline.publication.accepted,
    analysisStatus: pipeline.candidate.analysisStatus,
    coverageStatus: pipeline.candidate.coverage.status,
    decisionStatus: pipeline.candidate.decision.status,
    fallback: pipeline.candidate.decision.fallback ?? null,
    reasons: pipeline.candidate.decision.reasons ?? [],
    factKinds: adapterResult.facts.map((fact) => fact.kind).sort(),
    adapterComplete: adapterResult.complete,
    adapterDiagnostics: [...adapterResult.diagnostics].sort(),
  };
}

/**
 * 將 ratio 格式化成百分比。
 *
 * @param {number|null} value - 0..1 ratio。
 * @returns {string} readable percent。
 */
function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * 建立人類可讀 benchmark summary。
 *
 * @param {object} metrics - calculated metrics。
 * @returns {string} multi-line report。
 */
function formatSummary(metrics) {
  return [
    'Mutation Evaluation',
    '',
    `Total cases                  ${metrics.totalCases}`,
    `Critical cases               ${metrics.criticalTotal}`,
    `Critical caught              ${metrics.criticalCaught}`,
    `Critical false negatives     ${metrics.criticalFalseNegatives}`,
    `Critical direct facts        ${metrics.criticalDirectFactCount}`,
    `Critical fallback-only       ${metrics.criticalFallbackOnlyCount}`,
    `Safe cases                   ${metrics.safeTotal}`,
    `Safe reduced                 ${metrics.safeReduced}`,
    `Safe held for review         ${metrics.safeHeld}`,
    '',
    `Critical Recall              ${percent(metrics.criticalRecall)}`,
    `False Negative Rate          ${percent(metrics.falseNegativeRate)}`,
    `Critical Direct Fact Cover.  ${percent(metrics.criticalDirectFactCoverage)}`,
    `Safe Reduction Rate          ${percent(metrics.safeReductionRate)}`,
    `Partial Coverage Rate        ${percent(metrics.partialCoverageRate)}`,
    `Analysis Failure Rate        ${percent(metrics.analysisFailureRate)}`,
    `Full Review Fallback Rate    ${percent(metrics.fullReviewFallbackRate)}`,
  ].join('\n');
}

const cases = await readJson(new URL('./cases.json', import.meta.url));
const results = [];

for (const definition of cases) {
  results.push(await executeCase(definition));
}

const metrics = calculateMutationMetrics(results);
const failures = validateMutationEvaluation(results);
const report = {
  schemaVersion: 1,
  metrics,
  failures,
  cases: results,
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatSummary(metrics)}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nGate failures:\n- ${failures.join('\n- ')}\n`);
  }
}

if (failures.length > 0) {
  process.exitCode = 1;
}
