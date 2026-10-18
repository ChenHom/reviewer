import { Buffer } from 'node:buffer';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { executeAnalyzer } from '../analyzer-process.js';

/**
 * TypeScript / JavaScript adapter（第 1 階段）。
 *
 * analyzer（`analyzers/ts`，TypeScript compiler API）只判斷兩個版本的 AST 是否等價，不輸出 fact：
 * 等價時 `COMPLETE`，否則 `COV-TS-001:<原因>`（`FULL`）。
 */
export const TYPESCRIPT_ADAPTER_DESCRIPTOR = Object.freeze({
  id: 'typescript-v1',
  version: '0.1.0',
  languages: ['typescript', 'javascript'],
  capabilities: [
    'changed-regions',
    'runtime-context',
    'coverage-obligations',
    'semantic-facts',
  ],
});

const DEFAULT_ANALYZER_PATH = fileURLToPath(
  new URL('../../../analyzers/ts/bin/analyze.js', import.meta.url),
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
    adapterSet: [TYPESCRIPT_ADAPTER_DESCRIPTOR],
    obligations: [{
      id: 'COV-TS-001',
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
 * @param {string} source - head source。
 * @param {string} nodeVersion - analyzer 的 Node.js 版本。
 * @returns {object} changed region（呼叫端已排除空檔案）。
 */
function changedRegion(path, source, nodeVersion) {
  return {
    path,
    startByte: 0,
    endByte: Buffer.byteLength(source, 'utf8'),
    language: /\.(ts|tsx|mts|cts)$/i.test(path) ? 'typescript' : 'javascript',
    adapterId: TYPESCRIPT_ADAPTER_DESCRIPTOR.id,
    runtimeContext: {
      namespace: 'server',
      id: 'server:node',
      version: nodeVersion,
      source: 'node',
    },
  };
}

/**
 * 建立 TypeScript / JavaScript executable adapter。
 *
 * @param {{nodeBinary?: string, analyzerPath?: string}} [options={}] - 執行選項。
 * @returns {{descriptor: object, analyze: function}} executable adapter。
 */
export function createTypeScriptAdapter({
  nodeBinary = process.execPath,
  analyzerPath = DEFAULT_ANALYZER_PATH,
} = {}) {
  return {
    descriptor: TYPESCRIPT_ADAPTER_DESCRIPTOR,

    async analyze(request = {}, { signal } = {}) {
      const { path, beforeSource, afterSource } = request;
      if (
        typeof path !== 'string'
        || path.trim() === ''
        || typeof beforeSource !== 'string'
        || typeof afterSource !== 'string'
      ) {
        return terminalResult('TS_ANALYZER_INPUT_INVALID');
      }
      if (afterSource.length === 0) {
        return terminalResult('TS_FILE_DELETION_UNSUPPORTED', 'UNSUPPORTED');
      }

      const analysis = await executeAnalyzer({
        command: nodeBinary,
        args: [analyzerPath],
        payload: { path, beforeSource, afterSource },
        signal,
        prefix: 'TS_ANALYZER',
      });
      if (!analysis?.ok) {
        return terminalResult(analysis?.code ?? 'TS_ANALYZER_FAILED');
      }

      const region = changedRegion(path, afterSource, analysis.nodeVersion ?? process.version);
      const reasonCode = analysis.reasonCode ?? 'UNRECOGNIZED_TS_CHANGE';
      const facts = Array.isArray(analysis.facts)
        ? analysis.facts.map((fact) => ({
          ...fact,
          source: {
            adapterId: TYPESCRIPT_ADAPTER_DESCRIPTOR.id,
            adapterVersion: TYPESCRIPT_ADAPTER_DESCRIPTOR.version,
          },
        }))
        : [];

      return {
        adapterSet: [TYPESCRIPT_ADAPTER_DESCRIPTOR],
        obligations: [{
          id: 'COV-TS-001',
          required: true,
          status: analysis.status,
          changedRegions: [region],
          ...(analysis.complete ? {} : { reasonCode }),
        }],
        facts,
        diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics : [],
        evidenceReferences: [],
        complete: analysis.complete === true,
        ...(analysis.complete ? {} : { reasonCode }),
      };
    },
  };
}
