import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PHP_LARAVEL_ADAPTER_DESCRIPTOR = Object.freeze({
  id: 'php-laravel-v1',
  version: '0.1.0',
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
 * 透過 PHP CLI 執行 analyzer，並解析 JSON stdout。
 *
 * @param {object} options - analyzer execution options。
 * @param {string} options.analyzerPath - analyzer PHP script path。
 * @param {string} options.phpBinary - PHP executable。
 * @param {object} options.payload - analyzer stdin payload。
 * @param {AbortSignal|undefined} options.signal - abort signal。
 * @returns {Promise<object>} analyzer JSON result。
 */
function executePhpAnalyzer({
  analyzerPath,
  phpBinary,
  payload,
  signal,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(phpBinary, [analyzerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('PHP_ANALYZER_ABORTED'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`PHP_ANALYZER_EXIT_${code}:${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('PHP_ANALYZER_OUTPUT_INVALID'));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
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

      const analysis = await executePhpAnalyzer({
        analyzerPath,
        phpBinary,
        payload: { path, beforeSource, afterSource },
        signal,
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
