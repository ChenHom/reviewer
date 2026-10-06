import { readFile, readdir } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import { createAnalysisContextBinding } from '../../src/adapters/contracts.js';
import { createPhpLaravelAdapter } from '../../src/adapters/php-laravel/adapter.js';
import { PHP_LARAVEL_DOMAIN_INTERPRETERS } from '../../src/interpreters/php-laravel-domain.js';
import { createAuthorityState } from '../../src/publication.js';
import { runAdapterPipeline } from '../../src/runner.js';
import {
  aggregateHistoricalMetrics,
  calculateHistoricalMetrics,
  validateHistoricalEvaluation,
} from './metrics.js';
import { validateHistoricalManifest } from './schema.js';

const adapter=createPhpLaravelAdapter();

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function readManifest(url) {
  const payload=JSON.parse(await readFile(url, 'utf8'));
  const validation=validateHistoricalManifest(payload);
  if (!validation.valid) {
    throw new Error(`HISTORICAL_MANIFEST_INVALID:${validation.errors.join(',')}`);
  }
  return payload;
}

async function evaluateFile(manifest, manifestUrl, file) {
  const [beforeSource, afterSource]=await Promise.all([
    readFile(new URL(file.beforeFile, manifestUrl), 'utf8'),
    readFile(new URL(file.afterFile, manifestUrl), 'utf8'),
  ]);
  const identity={
    repository: manifest.repository,
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    policyId: 'historical-evaluation',
    policyVersion: '1',
    runnerVersion: '1',
  };
  const request={
    identity,
    path:file.path,
    beforeSource,
    afterSource,
  };
  const adapterResult=await adapter.analyze(request);
  const authorityState=createAuthorityState(
    identity,
    createAnalysisContextBinding(
      adapterResult,
      PHP_LARAVEL_DOMAIN_INTERPRETERS,
    ),
  );
  const pipeline=await runAdapterPipeline(
    adapter,
    request,
    authorityState,
    {
      timeoutMs:2_000,
      factInterpreters:PHP_LARAVEL_DOMAIN_INTERPRETERS,
    },
  );

  return {
    path:file.path,
    publicationAccepted:pipeline.publication.accepted,
    analysisStatus:pipeline.candidate.analysisStatus,
    coverageStatus:pipeline.candidate.coverage.status,
    decisionStatus:pipeline.candidate.decision.status,
    fallback:pipeline.candidate.decision.fallback ?? null,
    reasons:pipeline.candidate.decision.reasons ?? [],
    factKinds:adapterResult.facts.map((fact)=>fact.kind).sort(),
  };
}

/**
 * 評估單一 offline PR snapshot。
 *
 * Ground truth humanConcerns 不會傳給 Adapter/interpreter，只在 decisions 產生後比較。
 *
 * @param {URL} manifestUrl - snapshot manifest URL。
 * @returns {Promise<object>} evaluated case。
 */
export async function evaluateHistoricalCase(manifestUrl) {
  const manifest=await readManifest(manifestUrl);
  const files=[];

  for (const file of manifest.files) {
    files.push(await evaluateFile(manifest, manifestUrl, file));
  }

  return {
    id:manifest.id,
    sourceType:manifest.sourceType,
    repository:manifest.repository,
    baseSha:manifest.baseSha,
    headSha:manifest.headSha,
    files,
    metrics:calculateHistoricalMetrics(files, manifest.humanConcerns),
  };
}

async function defaultCaseUrls() {
  const dir=new URL('./cases/', import.meta.url);
  const names=(await readdir(dir))
    .filter((name)=>name.endsWith('.json'))
    .sort();
  return names.map((name)=>new URL(name, dir));
}

function formatSummary(metrics) {
  return [
    'Historical PR Evaluation',
    '',
    `Cases                        ${metrics.caseTotal}`,
    `Changed files                ${metrics.changedFilesTotal}`,
    `Selected files               ${metrics.selectedFilesTotal}`,
    `Human concerns               ${metrics.humanConcernTotal}`,
    `Human concerns covered       ${metrics.humanConcernCovered}`,
    `Human concerns missed        ${metrics.humanConcernMissed}`,
    '',
    `Human Concern Recall          ${percent(metrics.humanConcernRecall)}`,
    `Review Scope Reduction        ${percent(metrics.reviewScopeReduction)}`,
    `Analysis Failure Rate         ${percent(metrics.analysisFailureRate)}`,
    `Full Review Rate              ${percent(metrics.fullReviewRate)}`,
  ].join('\n');
}

const args=process.argv.slice(2).filter((arg)=>arg !== '--json');
const urls=args.length > 0
  ? args.map((arg)=>new URL(arg, `file://${process.cwd()}/`))
  : await defaultCaseUrls();

const cases=[];
for (const url of urls) {
  cases.push(await evaluateHistoricalCase(url));
}

const metrics=aggregateHistoricalMetrics(cases);
const failures=validateHistoricalEvaluation(cases);
const report={schemaVersion:1,metrics,failures,cases};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatSummary(metrics)}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nGate failures:\n- ${failures.join('\n- ')}\n`);
  }
}
if (failures.length > 0) process.exitCode=1;
