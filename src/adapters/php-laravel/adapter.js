import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import { executeAnalyzer } from '../analyzer-process.js';

export const PHP_LARAVEL_ADAPTER_DESCRIPTOR = Object.freeze({
  id: 'php-laravel-v1',
  // 0.2.0：fact schema v2（結構化 callee / container、CALL_ARGUMENT_REMOVED / ADDED）。
  version: '0.2.0',
  languages: ['php'],
  capabilities: [
    'changed-regions',
    'runtime-context',
    'coverage-obligations',
    'semantic-facts',
  ],
});

const DEFAULT_ANALYZER_PATH = fileURLToPath(
  new URL('../../../analyzers/php/bin/analyze.php', import.meta.url),
);

/**
 * 建立 fail-closed terminal AdapterResult。
 *
 * @param {string} code - stable failure/reason code。
 * @param {string} [status='FAILED'] - Adapter terminal status。
 * @returns {object} terminal AdapterResult。
 */
function terminalResult(code, status = 'FAILED') {
  return {
    adapterSet: [PHP_LARAVEL_ADAPTER_DESCRIPTOR],
    obligations: [{
      id: 'COV-PHP-001',
      required: true,
      status,
      changedRegions: [],
      reasonCode: code,
    }],
    facts: [],
    diagnostics: [code],
    evidenceReferences: [],
    complete: false,
    reasonCode: code,
  };
}

/**
 * 建立目前 head source 的 changed region。
 *
 * @param {string} path - repository path。
 * @param {string} source - head PHP source。
 * @param {string} phpVersion - PHP runtime version。
 * @returns {object|null} changed region；空檔案回傳 null。
 */
function changedRegion(path, source, phpVersion) {
  const endByte = Buffer.byteLength(source, 'utf8');
  if (endByte === 0) return null;

  return {
    path,
    startByte: 0,
    endByte,
    language: 'php',
    adapterId: PHP_LARAVEL_ADAPTER_DESCRIPTOR.id,
    runtimeContext: {
      namespace: 'server',
      id: 'server:php-cli',
      version: phpVersion,
      source: 'php-cli',
    },
  };
}

/**
 * 建立真實 PHP/Laravel executable adapter。
 *
 * Adapter 只產生 syntax/semantic facts，不產生 risk 或 review decision。
 *
 * @param {{phpBinary?: string, analyzerPath?: string}} [options={}] - PHP executable options。
 * @returns {{descriptor: object, analyze: function}} executable adapter。
 */
export function createPhpLaravelAdapter({
  phpBinary = 'php',
  analyzerPath = DEFAULT_ANALYZER_PATH,
} = {}) {
  return {
    descriptor: PHP_LARAVEL_ADAPTER_DESCRIPTOR,

    async analyze(request = {}, { signal } = {}) {
      const path = request.path;
      const beforeSource = request.beforeSource;
      const afterSource = request.afterSource;

      if (
        typeof path !== 'string'
        || path.trim() === ''
        || typeof beforeSource !== 'string'
        || typeof afterSource !== 'string'
      ) {
        return terminalResult('PHP_ANALYZER_INPUT_INVALID');
      }

      if (afterSource.length === 0) {
        return terminalResult('PHP_FILE_DELETION_UNSUPPORTED', 'UNSUPPORTED');
      }

      const analysis = await executeAnalyzer({
        command: phpBinary,
        args: [analyzerPath],
        payload: { path, beforeSource, afterSource },
        signal,
        prefix: 'PHP_ANALYZER',
      });

      if (!analysis?.ok) {
        return terminalResult(analysis?.code ?? 'PHP_ANALYZER_FAILED');
      }

      const region = changedRegion(path, afterSource, analysis.phpVersion);
      if (!region) {
        return terminalResult('PHP_EMPTY_HEAD_UNSUPPORTED', 'UNSUPPORTED');
      }

      const facts = Array.isArray(analysis.facts)
        ? analysis.facts.map((fact) => ({
          ...fact,
          source: {
            adapterId: PHP_LARAVEL_ADAPTER_DESCRIPTOR.id,
            adapterVersion: PHP_LARAVEL_ADAPTER_DESCRIPTOR.version,
          },
        }))
        : [];

      return {
        adapterSet: [PHP_LARAVEL_ADAPTER_DESCRIPTOR],
        obligations: [{
          id: 'COV-PHP-001',
          required: true,
          status: analysis.status,
          changedRegions: [region],
          ...(analysis.complete ? {} : {
            reasonCode: analysis.reasonCode ?? 'UNRECOGNIZED_PHP_CHANGE',
          }),
        }],
        facts,
        diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics : [],
        evidenceReferences: [],
        complete: analysis.complete === true,
        ...(analysis.complete ? {} : {
          reasonCode: analysis.reasonCode ?? 'UNRECOGNIZED_PHP_CHANGE',
        }),
      };
    },
  };
}
