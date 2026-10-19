/**
 * 第 2 層（AI）審查：機械審查之後，把 `AI_TRACK` 與 `ESCALATED` 檔案逐一交給 AI。
 *
 * - `AI_TRACK`：AI 判斷 PASS（不需要人工）、NEEDS_HUMAN（交給人工），或提出小修正（FIX）。
 *   修正只在 `apply` 時寫入 worktree（不 commit），而且必須通過檢查；否則視為需要人工。
 * - `ESCALATED`（單向門）：AI 只能補充說明、疑慮與流程圖，**不能放行**，之後一律交給人工。
 * - AI 失敗（API 錯誤、拒絕、輸出截斷或格式錯誤、輸入太大、超過檔案數上限）：該檔案需要人工（fail-closed）。
 * - 不送 `AUTO_PASS` 檔案。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { aiFindingsFor } from '../findings.js';
import { TRACK } from '../routing.js';
import { fileDiff, readTreeFile } from '../review/git.js';
import { fileMessage, systemBlocks } from './prompt.js';

export const STANDARDS_FILE = 'codingstandards.md';
export const AI_STATUS = Object.freeze({
  PASS: 'PASS',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  FIXED: 'FIXED',
  FAILED: 'FAILED',
});

const DIFF_CONTEXT = 5;
const DEFAULT_MAX_INPUT_CHARS = 200_000;
const DEFAULT_MAX_FILES = 50;

/**
 * 從 merge base 讀取 `codingstandards.md`（PR 修改它不影響這次審查，修改本身是 `POLICY_FILE_CHANGED`）。
 *
 * @param {string} repo - repository 根目錄。
 * @param {string} commit - merge base。
 * @returns {Promise<{path: string, commit: string, present: boolean, digest: string|null, text: string|null}>} 規範。
 */
export async function loadStandards(repo, commit) {
  const file = await readTreeFile(repo, commit, STANDARDS_FILE);
  const regular = file?.content && ['100644', '100755'].includes(file.mode) && !file.content.includes(0);
  if (!regular) return { path: STANDARDS_FILE, commit, present: false, digest: null, text: null };
  return {
    path: STANDARDS_FILE,
    commit,
    present: true,
    digest: createHash('sha256').update(file.content).digest('hex'),
    text: file.content.toString('utf8'),
  };
}

/**
 * 加上行號（`  12| code`）。
 *
 * @param {string} text - 原始碼。
 * @returns {string} 帶行號的內容。
 */
export function numberLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n');
}

/**
 * 單一檔案送給 AI 的內容。輸入過大時回報錯誤，不截斷 diff；完整內容放不下時明確告知 AI 省略。
 *
 * @param {object} context - `{ repo, mergeBase, headSha, maxInputChars, describeReason }`。
 * @param {object} file - file result。
 * @returns {Promise<{input?: object, error?: string}>} 輸入或錯誤代碼。
 */
export async function buildFileInput({ repo, mergeBase, headSha, maxInputChars, describeReason }, file) {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const diff = await fileDiff(repo, mergeBase, headSha, paths, DIFF_CONTEXT);
  if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) return { error: 'AI_INPUT_BINARY' };
  if (diff.length > maxInputChars) return { error: 'AI_INPUT_TOO_LARGE' };

  let content = null;
  let contentOmitted = null;
  if (file.fallback === 'FULL' && file.status !== 'deleted') {
    const head = await readTreeFile(repo, headSha, file.path);
    if (head?.content && ['100644', '100755'].includes(head.mode) && !head.content.includes(0)) {
      const numbered = numberLines(head.content.toString('utf8'));
      if (diff.length + numbered.length <= maxInputChars) content = numbered;
      else contentOmitted = 'file too large';
    }
  }

  return {
    input: {
      path: file.path,
      oldPath: file.oldPath ?? null,
      status: file.status,
      track: file.track,
      fallback: file.fallback ?? 'FULL',
      oneWayDoors: file.oneWayDoors ?? [],
      reasons: (file.reasons ?? []).map(describeReason),
      facts: (file.facts ?? []).map((fact) => `${fact.side}:L${fact.startLine}${fact.endLine === fact.startLine ? '' : `-${fact.endLine}`} ${fact.description}${
        fact.blockers?.length ? ` [${fact.blockers.filter((code) => !code.startsWith('FACT_UNHANDLED')).join(', ') || 'no domain rule'}]` : ''
      }`),
      diff,
      content,
      contentOmitted,
    },
  };
}

/**
 * 依序套用 AI 的修正：每個 `oldText` 必須在目前內容中恰好出現一次。
 *
 * @param {string} source - head 內容。
 * @param {Array<{oldText: string, newText: string}>} edits - 修正。
 * @returns {{ok: true, source: string}|{ok: false, error: string}} 結果。
 */
export function applyEdits(source, edits) {
  if (edits.length === 0) return { ok: false, error: 'AI_FIX_EMPTY' };
  let current = source;
  for (const { oldText, newText } of edits) {
    if (oldText === '') return { ok: false, error: 'AI_FIX_EDIT_EMPTY' };
    const first = current.indexOf(oldText);
    if (first === -1) return { ok: false, error: 'AI_FIX_EDIT_NOT_FOUND' };
    if (current.indexOf(oldText, first + 1) !== -1) return { ok: false, error: 'AI_FIX_EDIT_NOT_UNIQUE' };
    current = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
  }
  return current === source ? { ok: false, error: 'AI_FIX_NO_CHANGE' } : { ok: true, source: current };
}

/**
 * 套用修正到 worktree。只用於 `AI_TRACK` 檔案；worktree 的檔案必須與 head 相同，
 * 修正後的內容交給機械審查，命中單向門時不套用。
 *
 * @param {object} context - `{ repo, headSha, checkFix }`。
 * @param {object} file - file result。
 * @param {object} fix - AI 輸出的 fix。
 * @returns {Promise<{applied: boolean, error?: string}>} 結果。
 */
async function applyFix({ repo, headSha, checkFix }, file, fix) {
  if (file.status === 'deleted') return { applied: false, error: 'AI_FIX_FILE_DELETED' };
  const head = await readTreeFile(repo, headSha, file.path);
  if (!head?.content || !['100644', '100755'].includes(head.mode) || head.content.includes(0)) {
    return { applied: false, error: 'AI_FIX_FILE_UNSUPPORTED' };
  }
  const headSource = head.content.toString('utf8');
  const target = join(repo, file.path);
  let worktreeSource;
  try {
    worktreeSource = await readFile(target, 'utf8');
  } catch {
    return { applied: false, error: 'AI_FIX_WORKTREE_MISMATCH' };
  }
  if (worktreeSource !== headSource) return { applied: false, error: 'AI_FIX_WORKTREE_MISMATCH' };

  const edited = applyEdits(headSource, fix.edits);
  if (!edited.ok) return { applied: false, error: edited.error };
  let check;
  try {
    check = await checkFix(file.path, headSource, edited.source);
  } catch {
    return { applied: false, error: 'AI_FIX_CHECK_FAILED' };
  }
  if (check.track === TRACK.ESCALATED) return { applied: false, error: 'AI_FIX_HITS_ONE_WAY_DOOR' };
  await writeFile(target, edited.source);
  return { applied: true };
}

/**
 * 依 AI 的輸出決定檔案的 AI 狀態。
 *
 * - high 的 concern 一律需要人工；FIX 沒有套用時需要人工（修正變成建議）。
 * - `ESCALATED` 的狀態只代表 AI 的意見，檔案仍需要人工。
 *
 * @param {object} context - review context。
 * @param {object} file - file result。
 * @param {object} output - AI 輸出。
 * @returns {Promise<{status: string, fix: object|null}>} 狀態與修正結果。
 */
async function decide(context, file, output) {
  const hasHigh = output.concerns.some((concern) => concern.severity === 'high');
  const proposed = output.fix.edits.length > 0
    ? { description: output.fix.description, edits: output.fix.edits, applied: false, error: null }
    : null;
  if (output.verdict === 'PASS') return { status: hasHigh ? AI_STATUS.NEEDS_HUMAN : AI_STATUS.PASS, fix: proposed };
  if (output.verdict === 'NEEDS_HUMAN') return { status: AI_STATUS.NEEDS_HUMAN, fix: proposed };

  // FIX
  if (!proposed) return { status: AI_STATUS.NEEDS_HUMAN, fix: { description: output.fix.description, edits: [], applied: false, error: 'AI_FIX_EMPTY' } };
  if (file.track !== TRACK.AI_TRACK) return { status: AI_STATUS.NEEDS_HUMAN, fix: { ...proposed, error: 'AI_FIX_NOT_ALLOWED_ON_ESCALATED' } };
  if (!context.apply) return { status: AI_STATUS.NEEDS_HUMAN, fix: proposed };
  if (hasHigh) return { status: AI_STATUS.NEEDS_HUMAN, fix: { ...proposed, error: 'AI_FIX_HAS_HIGH_CONCERN' } };
  const result = await applyFix(context, file, proposed);
  return result.applied
    ? { status: AI_STATUS.FIXED, fix: { ...proposed, applied: true } }
    : { status: AI_STATUS.NEEDS_HUMAN, fix: { ...proposed, error: result.error } };
}

/**
 * 以固定並行數處理 items，結果維持原順序。
 *
 * @param {Array} items - 輸入。
 * @param {number} concurrency - 同時處理數。
 * @param {function} worker - async (item, index) => result。
 * @returns {Promise<Array>} 結果。
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  return results;
}

/**
 * 檔案是否需要人工：`ESCALATED` 一律需要；`AI_TRACK` 在 AI 判斷需要人工、AI 失敗或沒有 AI 審查時需要。
 *
 * @param {object} file - file result。
 * @returns {boolean} 是否需要人工。
 */
export function needsHuman(file) {
  if (file.track === TRACK.AUTO_PASS) return false;
  if (file.track === TRACK.AI_TRACK && file.ai) return [AI_STATUS.NEEDS_HUMAN, AI_STATUS.FAILED].includes(file.ai.status);
  return true;
}

/**
 * 審查所有需要 review 的檔案。
 *
 * @param {object[]} files - 已路由的 file results。
 * @param {object} options - 選項。
 * @param {string} options.repo - repository 根目錄。
 * @param {string} options.mergeBase - merge base。
 * @param {string} options.headSha - head commit。
 * @param {{model: string, effort: string, review: function}} options.reviewer - createAnthropicReviewer() 的結果。
 * @param {function(string): string} options.describeReason - 原因代碼的說明文字。
 * @param {function(string, string, string): Promise<{track: string}>} options.checkFix - 修正後內容的機械審查。
 * @param {boolean} [options.apply=false] - 套用 `AI_TRACK` 檔案的修正到 worktree。
 * @param {number} [options.concurrency=4] - 同時進行的 AI 請求數。
 * @param {number} [options.maxInputChars=200000] - 單一檔案輸入的上限（字元）。
 * @param {number} [options.maxFiles=50] - 最多審查的檔案數；超過的檔案視為 AI 失敗。
 * @returns {Promise<{files: object[], summary: object}>} 帶 `ai` 的 files 與彙總。
 */
export async function runAiReview(files, {
  repo, mergeBase, headSha, reviewer, describeReason, checkFix,
  apply = false, concurrency = 4, maxInputChars = DEFAULT_MAX_INPUT_CHARS, maxFiles = DEFAULT_MAX_FILES,
}) {
  const standards = await loadStandards(repo, mergeBase);
  const system = systemBlocks(standards);
  const context = { repo, mergeBase, headSha, maxInputChars, describeReason, checkFix, apply };
  const targets = files.filter((file) => file.track !== TRACK.AUTO_PASS);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  const reviewOne = async (file, index) => {
    const failed = (error, extra = {}) => ({ status: AI_STATUS.FAILED, error, summary: '', concerns: [], fix: null, flowchart: '', ...extra });
    if (index >= maxFiles) return failed('AI_FILE_LIMIT_EXCEEDED');
    const built = await buildFileInput(context, file);
    if (built.error) return failed(built.error);
    const result = await reviewer.review({ system, message: fileMessage(built.input) });
    for (const key of Object.keys(usage)) usage[key] += result.usage?.[key] ?? 0;
    const meta = { model: result.model, fallback: result.fallback };
    if (!result.ok) return failed(result.error, meta);
    const { status, fix } = await decide(context, file, result.output);
    return {
      status,
      error: null,
      summary: result.output.summary,
      concerns: result.output.concerns,
      fix,
      flowchart: result.output.flowchart,
      ...meta,
    };
  };

  const results = await mapWithConcurrency(targets, concurrency, reviewOne);
  const byPath = new Map(targets.map((file, index) => [file, results[index]]));
  const reviewed = files.map((file) => {
    const ai = byPath.get(file);
    if (!ai) return { ...file, needsHuman: needsHuman(file) };
    const withAi = { ...file, ai };
    return { ...withAi, findings: [...(file.findings ?? []), ...aiFindingsFor(withAi)], needsHuman: needsHuman(withAi) };
  });

  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    files: reviewed,
    summary: {
      model: reviewer.model,
      effort: reviewer.effort,
      apply,
      standards: { path: standards.path, commit: standards.commit, present: standards.present, digest: standards.digest },
      reviewed: targets.length,
      pass: count(AI_STATUS.PASS),
      needsHuman: count(AI_STATUS.NEEDS_HUMAN),
      fixed: count(AI_STATUS.FIXED),
      failed: count(AI_STATUS.FAILED),
      fallbackUsed: results.filter((result) => result.fallback).length,
      usage,
    },
  };
}

/**
 * PR 層級的人工需求。沒有 AI 審查時，`AI_TRACK` 檔案也需要人工（沒有人看過）。
 *
 * @param {object[]} files - file results（已帶 `needsHuman` 與 `findings`）。
 * @returns {{required: boolean, files: number, findings: number, pendingFixes: number}} 彙總。
 */
export function summarizeHuman(files) {
  const human = files.filter((file) => file.needsHuman);
  return {
    required: human.length > 0,
    files: human.length,
    findings: human.reduce((total, file) => total + (file.findings?.length ?? 0), 0),
    pendingFixes: files.filter((file) => file.ai?.status === AI_STATUS.FIXED).length,
  };
}
