import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

import { createAnalysisContextBinding } from '../adapters/contracts.js';
import { CONFIG_FILE, POLICY_FILES, createProjectPolicy, parseProjectConfig } from '../config/project-config.js';
import { createPhpLaravelAdapter } from '../adapters/php-laravel/adapter.js';
import { createTypeScriptAdapter } from '../adapters/typescript/adapter.js';
import { displayArgument, displayText } from '../facts/structured.js';
import { createAuthorityState } from '../publication.js';
import { routeFile, summarizeTracks } from '../routing.js';
import { runAdapterPipeline } from '../runner.js';
import { diffEntries, diffHunks, mergeBase, readBlob, readTreeFile, repositoryRoot, resolveCommit } from './git.js';

export const NOT_SELECTED = 'NOT_SELECTED_FOR_HUMAN_REVIEW';
export const HUMAN_REVIEW = 'HUMAN_REVIEW_REQUIRED';

/**
 * 依副檔名選擇 adapter 與 interpreter presets。未列出的副檔名不送 analyzer（`UNSUPPORTED_FILE_TYPE`）。
 * `presets` 是沒有專案設定時的預設值。
 */
export const LANGUAGES = Object.freeze([
  Object.freeze({
    id: 'php',
    match: /\.php$/i,
    createAdapter: createPhpLaravelAdapter,
    presets: Object.freeze(['php-laravel', 'payments']),
  }),
  Object.freeze({
    id: 'ts',
    // 型別宣告檔（`.d.ts`）不送 analyzer。
    match: /^(?!.*\.d\.[mc]?ts$).*\.(?:[mc]?ts|tsx|[mc]?js|jsx)$/i,
    createAdapter: createTypeScriptAdapter,
    presets: Object.freeze([]),
  }),
]);

/**
 * 找出路徑對應的語言設定。
 *
 * @param {string} path - repository 相對路徑。
 * @param {object[]} [languages=LANGUAGES] - 語言設定。
 * @returns {object|null} 語言設定；不支援時為 null。
 */
export function languageFor(path, languages = LANGUAGES) {
  return languages.find((language) => language.match.test(path)) ?? null;
}

const STATUS_NAMES = Object.freeze({
  A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type-changed',
});

/**
 * 建立 byte offset → 行號（1-based）的查詢函式。
 *
 * @param {string} source - 原始碼。
 * @returns {function(number): number} offset → line。
 */
export function lineLocator(source) {
  const bytes = Buffer.from(source, 'utf8');
  const lineStarts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) lineStarts.push(index + 1);
  }

  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

const MAX_SNIPPET = 80;

/**
 * 把原始碼片段壓成一行並截斷，避免多行運算式破壞輸出格式。
 *
 * @param {unknown} value - 原始碼片段。
 * @returns {string} 單行片段。
 */
function snippet(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET - 1)}…` : text;
}

/**
 * 產生 fact 的簡短描述，讓 reviewer 不必讀 JSON 也知道變更內容。
 *
 * @param {object} fact - semantic fact。
 * @returns {string} 描述。
 */
export function describeFact(fact) {
  const raw = fact.properties ?? {};
  const p = Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    if (['before', 'after', 'value', 'condition'].includes(key) && value !== null) return [key, snippet(value)];
    if (key === 'callee' || key === 'container') return [key, displayText(value)];
    if (key === 'argument') return [key, displayArgument(value)];
    return [key, value];
  }));
  switch (fact.kind) {
    case 'CALL_REMOVED':
      return `移除呼叫 ${p.callee}`;
    case 'CALL_ADDED':
      return `新增呼叫 ${p.callee}`;
    case 'CALL_ARGUMENT_CHANGED':
      return `${p.callee} 的參數 ${p.argument}：${p.before} → ${p.after}`;
    case 'CALL_ARGUMENT_REMOVED':
      return `${p.callee} 移除參數 ${p.argument}：${p.value}`;
    case 'CALL_ARGUMENT_ADDED':
      return `${p.callee} 新增參數 ${p.argument}：${p.value}`;
    case 'BINARY_OPERATOR_CHANGED':
      return `運算子 ${p.operatorBefore} → ${p.operatorAfter}：${p.before} → ${p.after}`;
    case 'GUARD_REMOVED':
      return `移除 guard：if (${p.condition}) ${p.exit}`;
    case 'GUARD_ADDED':
      return `新增 guard：if (${p.condition}) ${p.exit}`;
    case 'ARRAY_ITEM_REMOVED':
      return `${p.container} 移除元素 ${p.key === null ? '' : `${p.key} => `}${p.value}`;
    case 'ARRAY_ITEM_ADDED':
      return `${p.container} 新增元素 ${p.key === null ? '' : `${p.key} => `}${p.value}`;
    case 'LITERAL_CHANGED':
      return `值 ${p.before} → ${p.after}（${p.container}）`;
    case 'EXPRESSION_NEGATED':
      return `反轉：${p.before} → ${p.after}`;
    case 'RETURN_VALUE_CHANGED':
      return `回傳值 ${p.before || '（無）'} → ${p.after || '（無）'}`;
    case 'CALL_ARGUMENTS_REORDERED':
      return `${p.callee} 的參數順序：(${p.before}) → (${p.after})`;
    case 'VARIABLE_CHANGED':
      return `${raw.container?.type === 'param' ? '參數' : '變數'} ${p.before} → ${p.after}`;
    default:
      return fact.kind;
  }
}

/**
 * 把 hunk 轉成行號範圍：有新內容時指向 head，純刪除時指向 base。
 *
 * @param {object[]} hunks - parseHunks() 結果。
 * @returns {Array<{side: string, startLine: number, endLine: number}>} 變更位置。
 */
export function changedLines(hunks) {
  return hunks.map((hunk) => (hunk.headCount > 0
    ? { side: 'head', startLine: hunk.headStart, endLine: hunk.headStart + hunk.headCount - 1 }
    : { side: 'base', startLine: hunk.baseStart, endLine: hunk.baseStart + Math.max(hunk.baseCount, 1) - 1 }));
}

/**
 * 修改 / 改名檔案的變更位置（新增、刪除的檔案整個都是變更，不另外列出）。
 *
 * @param {object} context - analysis context。
 * @param {object} entry - diff entry。
 * @returns {Promise<object[]>} 變更位置。
 */
async function changedLinesFor(context, entry) {
  if (!['M', 'R'].includes(entry.status)) return [];
  const paths = entry.status === 'R' ? [entry.oldPath, entry.newPath] : [entry.newPath];
  return changedLines(await diffHunks(context.repo, context.identity.baseSha, context.identity.headSha, paths));
}

/**
 * 不經 analyzer、直接要求完整 review 的檔案結果。
 *
 * @param {object} base - 檔案基本資訊。
 * @param {string} reason - 原因代碼。
 * @returns {object} file result。
 */
function fullReview(base, reason) {
  return { ...base, analyzed: false, decision: HUMAN_REVIEW, fallback: 'FULL', reasons: [reason], facts: [] };
}

/**
 * 以完整 pipeline 分析單一 PHP 檔案的 before / after。
 *
 * @param {object} context - adapter、interpreters、identity 與 timeout。
 * @param {string} path - repository 相對路徑。
 * @param {string} beforeSource - base 版本。
 * @param {string} afterSource - head 版本。
 * @returns {Promise<{decision: object, facts: object[]}>} pipeline 結果。
 */
async function analyzeFile({ adapter, interpreters, identity, timeoutMs }, path, beforeSource, afterSource) {
  const request = { identity, path, beforeSource, afterSource };
  const adapterResult = await adapter.analyze(request, { signal: globalThis.AbortSignal.timeout(timeoutMs) });

  // pipeline 內部會再呼叫一次 adapter；共用同一份結果，避免同一檔案跑兩次 analyzer。
  const replay = { descriptor: adapter.descriptor, analyze: async () => globalThis.structuredClone(adapterResult) };
  const state = createAuthorityState(identity, createAnalysisContextBinding(adapterResult, interpreters));
  const pipeline = await runAdapterPipeline(replay, request, state, { timeoutMs, factInterpreters: interpreters });

  return { decision: pipeline.candidate?.decision ?? {}, facts: adapterResult.facts ?? [] };
}

/**
 * 決定單一 diff entry 的 review 結果。
 *
 * - 只有 `LANGUAGES` 支援的檔案的修改（含 rename）會送進 analyzer；新增、刪除、不支援的檔案、
 *   binary、symlink、submodule 一律要求完整 review。
 * - rename 或權限變更即使內容等價也要求 review（autoload 路徑、執行權限可能改變行為）。
 *
 * @param {object} context - analysis context。
 * @param {object} entry - diff entry。
 * @returns {Promise<object>} file result。
 */
async function reviewEntry(context, entry) {
  const result = applyProjectPolicy(await classifyEntry(context, entry), context.project);
  return result.decision === NOT_SELECTED ? result : { ...result, changedLines: await changedLinesFor(context, entry) };
}

/**
 * 套用專案設定對檔案的要求（只會讓結果變嚴格）：
 *
 * - 修改審查規則本身（`.reviewer.json`、`codingstandards.md`）→ `POLICY_FILE_CHANGED`。
 * - 符合 `protectedPaths` → `PROTECTED_PATH`。
 * - 專案設定無效 → `POLICY_CONFIG_INVALID`，一律 `FULL`。
 *
 * @param {object} file - file result。
 * @param {{policy: object, invalid: boolean}} project - 專案 policy 與設定狀態。
 * @returns {object} file result。
 */
export function applyProjectPolicy(file, { policy, invalid }) {
  const paths = [file.path, file.oldPath].filter(Boolean);
  const extra = [];
  if (paths.some((path) => POLICY_FILES.includes(path))) extra.push('POLICY_FILE_CHANGED');
  if (paths.some((path) => policy.isProtectedPath(path))) extra.push('PROTECTED_PATH');
  if (invalid) extra.push('POLICY_CONFIG_INVALID');
  if (extra.length === 0) return file;

  const selected = file.decision === NOT_SELECTED;
  return {
    ...file,
    decision: HUMAN_REVIEW,
    fallback: invalid ? 'FULL' : (selected ? 'TARGETED' : file.fallback),
    reasons: selected ? extra : [...file.reasons, ...extra],
  };
}

/**
 * 從 merge base 讀取專案設定。PR 修改設定不影響這次的 review（修改本身是 `POLICY_FILE_CHANGED`）。
 *
 * @param {string} repo - repository 根目錄。
 * @param {string} commit - merge base。
 * @returns {Promise<object>} `{ path, commit, status, errors, digest, parsed }`；status 為 `absent` / `valid` / `invalid`。
 */
export async function loadProjectConfig(repo, commit) {
  const base = { path: CONFIG_FILE, commit };
  const file = await readTreeFile(repo, commit, CONFIG_FILE);
  if (!file) return { ...base, status: 'absent', errors: [], digest: null, parsed: null };
  if (!['100644', '100755'].includes(file.mode)) {
    return { ...base, status: 'invalid', errors: ['POLICY_CONFIG_NOT_REGULAR_FILE'], digest: null, parsed: null };
  }

  const parsed = parseProjectConfig(file.content.toString('utf8'));
  return parsed.valid
    ? { ...base, status: 'valid', errors: [], digest: parsed.digest, parsed }
    : { ...base, status: 'invalid', errors: parsed.errors, digest: null, parsed: null };
}

/**
 * reviewEntry 的決策部分（不含變更位置）。
 *
 * @param {object} context - analysis context。
 * @param {object} entry - diff entry。
 * @returns {Promise<object>} file result。
 */
async function classifyEntry(context, entry) {
  const path = entry.newPath ?? entry.oldPath;
  const base = {
    path,
    ...(entry.status === 'R' ? { oldPath: entry.oldPath } : {}),
    status: STATUS_NAMES[entry.status] ?? entry.status,
  };

  if (!['A', 'D', 'M', 'R'].includes(entry.status)) return fullReview(base, `UNSUPPORTED_CHANGE_TYPE:${base.status}`);
  if ([entry.oldMode, entry.newMode].includes('160000')) return fullReview(base, 'SUBMODULE_CHANGED');
  if ([entry.oldMode, entry.newMode].includes('120000')) return fullReview(base, 'SYMLINK_CHANGED');
  const language = languageFor(path, context.languages);
  if (!language) return fullReview(base, 'UNSUPPORTED_FILE_TYPE');
  if (entry.status === 'A') return fullReview(base, 'FILE_ADDED');
  if (entry.status === 'D') return fullReview(base, 'FILE_DELETED');

  const [before, after] = await Promise.all([
    readBlob(context.repo, entry.oldSha),
    readBlob(context.repo, entry.newSha),
  ]);
  if (before.includes(0) || after.includes(0)) return fullReview(base, 'BINARY_FILE');

  const beforeSource = before.toString('utf8');
  const afterSource = after.toString('utf8');
  let analysis;
  try {
    analysis = await analyzeFile({ ...context, ...language }, path, beforeSource, afterSource);
  } catch (error) {
    return fullReview(base, `ANALYZER_ERROR:${String(error?.message ?? error).slice(0, 200)}`);
  }

  const reasons = [...(analysis.decision.reasons ?? [])];
  let decision = analysis.decision.status === NOT_SELECTED ? NOT_SELECTED : HUMAN_REVIEW;
  let fallback = decision === NOT_SELECTED ? null : (analysis.decision.fallback ?? 'FULL');
  const extra = [];
  if (entry.status === 'R') extra.push('FILE_RENAMED');
  if (entry.oldMode !== entry.newMode) extra.push('FILE_MODE_CHANGED');
  if (extra.length > 0) {
    if (decision === NOT_SELECTED) {
      decision = HUMAN_REVIEW;
      fallback = 'TARGETED';
      reasons.length = 0;
    }
    reasons.push(...extra);
  }

  const locate = { before: lineLocator(beforeSource), after: lineLocator(afterSource) };
  const facts = analysis.facts.map((fact) => {
    const side = fact.properties?.changeSide === 'before' ? 'before' : 'after';
    const startByte = fact.provenance?.startByte ?? 0;
    const endByte = Math.max(startByte, (fact.provenance?.endByte ?? startByte) - 1);
    return {
      kind: fact.kind,
      side: side === 'before' ? 'base' : 'head',
      startLine: locate[side](startByte),
      endLine: locate[side](endByte),
      description: describeFact(fact),
    };
  });

  return { ...base, analyzed: true, decision, fallback, reasons, facts };
}

/**
 * 以固定並行數依序處理 items，結果維持原順序。
 *
 * @param {Array} items - 輸入。
 * @param {number} concurrency - 同時處理數。
 * @param {function} worker - async (item) => result。
 * @returns {Promise<Array>} 結果。
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  return results;
}

/**
 * 彙整成 PR 層級的決策：所有檔案都不需 review 時才是 NOT_SELECTED。
 *
 * @param {object[]} files - file results。
 * @returns {object} PR decision。
 */
export function summarizeFiles(files) {
  const needsReview = files.filter((file) => file.decision !== NOT_SELECTED);
  return {
    status: needsReview.length === 0 ? NOT_SELECTED : HUMAN_REVIEW,
    reasons: files.length === 0 ? ['NO_CHANGES'] : [...new Set(needsReview.flatMap((file) => file.reasons))].sort(),
    files: files.length,
    notSelected: files.length - needsReview.length,
    targeted: needsReview.filter((file) => file.fallback === 'TARGETED').length,
    full: needsReview.filter((file) => file.fallback !== 'TARGETED').length,
  };
}

/**
 * Review 一段 git 範圍（base..head）的所有檔案變更。
 *
 * @param {object} options - review 選項。
 * @param {string} options.repo - repository 路徑。
 * @param {string} options.base - base ref。
 * @param {string} options.head - head ref。
 * @param {number} [options.concurrency=4] - 同時執行的 analyzer 數。
 * @param {number} [options.timeoutMs=30000] - 單一檔案的 analyzer deadline。
 * @param {object} [options.adapterOptions={}] - 各語言 adapter 的選項，以語言 id 為 key（例如 `{ php: { phpBinary } }`）。
 * @returns {Promise<object>} review report。
 */
export async function reviewRange({ repo, base, head, concurrency = 4, timeoutMs = 30_000, adapterOptions = {} }) {
  const [root, baseSha, headSha] = await Promise.all([
    repositoryRoot(repo),
    resolveCommit(repo, base),
    resolveCommit(repo, head),
  ]);
  // 與 GitHub PR 相同，只看 head 相對於 merge base 的變更：base 在分支建立後的新 commit 不算在內。
  const forkPoint = await mergeBase(root, baseSha, headSha);
  const [entries, config] = await Promise.all([diffEntries(root, forkPoint, headSha), loadProjectConfig(root, forkPoint)]);
  // 設定無效時以預設值分析（仍列出 fact），但每個檔案都是 FULL + POLICY_CONFIG_INVALID。
  const policy = createProjectPolicy(config.parsed);
  const context = {
    repo: root,
    project: { policy, invalid: config.status === 'invalid' },
    languages: LANGUAGES.map((language) => ({
      ...language,
      adapter: language.createAdapter(adapterOptions[language.id]),
      interpreters: policy.interpretersFor(language),
    })),
    timeoutMs,
    identity: {
      repository: basename(root),
      baseSha: forkPoint,
      headSha,
      policyId: 'pr-review',
      policyVersion: '1',
      runnerVersion: '1',
    },
  };
  const reviewed = await mapWithConcurrency(entries, concurrency, (entry) => reviewEntry(context, entry));
  const routingOptions = { oneWayDoors: policy.oneWayDoors, aiTrackPath: policy.isAiTrackPath };
  const files = reviewed.map((file) => ({ ...file, ...routeFile(file, routingOptions) }));

  return {
    repository: basename(root),
    base: { ref: base, sha: baseSha },
    head: { ref: head, sha: headSha },
    mergeBase: forkPoint,
    config: { path: config.path, commit: config.commit, status: config.status, errors: config.errors, digest: config.digest },
    decision: summarizeFiles(files),
    routing: summarizeTracks(files),
    files,
  };
}
