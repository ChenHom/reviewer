/**
 * Retro 的 deterministic 指標：讀取一段期間內 `bin/review.js --out` 的 JSON 報表（以及可選的人工留言、
 * `codingstandards.md`、`.reviewer.json`），找出可以強化或精簡的地方。
 *
 * 指標只來自報表內容；豁免率、REOPENED 次數、宣告與偵測不一致等需要 GitHub 狀態留言的指標
 * 要等設計的步驟 7，這裡列為不可用。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createProjectPolicy } from '../config/project-config.js';
import { baseCode } from '../routing.js';

const TOP = 10;

/**
 * 讀取 JSON 報表：參數可以是檔案或目錄（目錄中所有 `.json`，不遞迴）。無法解析或不像 review 報表的檔案列在 `errors`。
 *
 * @param {string[]} paths - 檔案或目錄。
 * @returns {Promise<{reports: object[], errors: string[]}>} 報表與錯誤。
 */
export async function loadReports(paths) {
  const files = [];
  for (const path of paths) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).filter((entry) => entry.endsWith('.json')).sort()) files.push(join(path, name));
    } else {
      files.push(path);
    }
  }
  const reports = [];
  const errors = [];
  for (const file of files) {
    let report;
    try {
      report = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      errors.push(`REPORT_NOT_JSON:${file}`);
      continue;
    }
    if (!Array.isArray(report?.files) || typeof report?.head?.sha !== 'string' || typeof report?.decision?.status !== 'string') {
      errors.push(`REPORT_SHAPE_INVALID:${file}`);
      continue;
    }
    reports.push(report);
  }
  return { reports, errors };
}

/**
 * 讀取人工留言（JSON Lines，每行 `{ "pr", "path", "body", "author" }`；`body` 必填）。
 *
 * @param {string} text - 檔案內容。
 * @returns {{comments: object[], errors: string[]}} 留言與錯誤（行號）。
 */
export function parseComments(text) {
  const comments = [];
  const errors = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const value = JSON.parse(line);
      if (typeof value?.body !== 'string' || value.body.trim() === '') throw new Error('body');
      comments.push({
        pr: value.pr === undefined ? null : String(value.pr),
        path: typeof value.path === 'string' ? value.path : null,
        author: typeof value.author === 'string' ? value.author : null,
        body: value.body,
      });
    } catch {
      errors.push(`COMMENT_INVALID:line ${index + 1}`);
    }
  });
  return { comments, errors };
}

/**
 * `codingstandards.md` 中的條目（以 `-`、`*`、`1.` 開頭的列表項目）。
 *
 * @param {string} text - markdown。
 * @returns {string[]} 條目。
 */
export function standardsRules(text) {
  return text.split('\n')
    .map((line) => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)?.[1].trim())
    .filter((rule) => rule && rule.length > 0);
}

/**
 * 計數後依次數（再依名稱）排序，取前 n 個。
 *
 * @param {Iterable<string>} values - 值。
 * @param {number} [limit=TOP] - 數量上限。
 * @returns {Array<{code: string, count: number}>} 排序後的計數。
 */
function top(values, limit = TOP) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, limit);
}

/**
 * 原因代碼去掉參數中的細節（`ANALYZER_ERROR:<訊息>` → `ANALYZER_ERROR`，`COV-PHP-001:X` 保留）。
 *
 * @param {string} reason - 原因。
 * @returns {string} 彙總用的代碼。
 */
function reasonKey(reason) {
  return /^COV-[A-Z]+-\d+:/.test(reason) ? reason : reason.split(':')[0];
}

/**
 * 正規化（比對規範條目用）。
 *
 * @param {string} text - 文字。
 * @returns {string} 正規化後的文字。
 */
function normalize(text) {
  return text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 計算 retro 指標。
 *
 * @param {object[]} reports - review 報表。
 * @param {object} [options={}] - 選項。
 * @param {string|null} [options.standards=null] - `codingstandards.md` 的內容。
 * @param {object|null} [options.config=null] - parseProjectConfig() 的有效結果。
 * @param {object[]|null} [options.comments=null] - 人工留言。
 * @returns {object} 指標。
 */
export function computeRetroMetrics(reports, { standards = null, config = null, comments = null } = {}) {
  // 同一個 head 的報表（例如重跑）只算一次，保留最後一份。
  const unique = [...new Map(reports.map((report) => [`${report.repository}@${report.head.sha}`, report])).values()];
  const files = unique.flatMap((report) => report.files);
  const needsReview = files.filter((file) => file.track !== 'AUTO_PASS');
  const count = (predicate) => files.filter(predicate).length;
  const ratio = (value, total) => (total === 0 ? null : value / total);

  // 與 review 相同的單向門集合：預設值、`rules.oneWayDoors` 與 `protectedArguments` 自訂的 blocker。
  const doors = new Set(createProjectPolicy(config?.valid ? config : null).oneWayDoors);
  // 與路由相同，以基本代碼彙總（設定的 `FACT_UNHANDLED` 對應到 `FACT_UNHANDLED:ts-1` 等）。
  const triggered = files.flatMap((file) => (file.oneWayDoors ?? []).map(baseCode));
  const unhandled = files.flatMap((file) => (file.facts ?? [])
    .filter((fact) => (fact.blockers ?? []).some((code) => code.startsWith('FACT_UNHANDLED')))
    .map((fact) => ({ kind: fact.kind, description: fact.description, path: file.path })));
  const unhandledKinds = top(unhandled.map((fact) => fact.kind)).map(({ code, count: total }) => ({
    kind: code,
    count: total,
    examples: [...new Set(unhandled.filter((fact) => fact.kind === code).map((fact) => `${fact.path}：${fact.description}`))].slice(0, 3),
  }));

  const reviewed = files.filter((file) => file.ai);
  const ai = reviewed.length === 0 ? null : {
    files: reviewed.length,
    pass: reviewed.filter((file) => file.ai.status === 'PASS').length,
    needsHuman: reviewed.filter((file) => file.ai.status === 'NEEDS_HUMAN').length,
    fixed: reviewed.filter((file) => file.ai.status === 'FIXED').length,
    failed: reviewed.filter((file) => file.ai.status === 'FAILED').length,
    failureReasons: top(reviewed.filter((file) => file.ai.status === 'FAILED').map((file) => reasonKey(String(file.ai.error)))),
    aiTrackClearRate: ratio(
      reviewed.filter((file) => file.track === 'AI_TRACK' && ['PASS', 'FIXED'].includes(file.ai.status)).length,
      reviewed.filter((file) => file.track === 'AI_TRACK').length,
    ),
    fallbackUsed: reviewed.filter((file) => file.ai.fallback).length,
    usage: unique.reduce((total, report) => {
      for (const [key, value] of Object.entries(report.ai?.usage ?? {})) total[key] = (total[key] ?? 0) + value;
      return total;
    }, {}),
  };

  const concerns = reviewed.flatMap((file) => (file.ai.concerns ?? []).map((concern) => ({ ...concern, path: file.path })));
  let standardsMetrics = null;
  if (standards !== null) {
    const rules = standardsRules(standards);
    const citations = concerns.map((concern) => concern.standard).filter((quote) => typeof quote === 'string' && quote.trim() !== '');
    const matches = (rule, quote) => normalize(rule).includes(normalize(quote)) || normalize(quote).includes(normalize(rule));
    const cited = rules.map((rule) => ({ rule, count: citations.filter((quote) => matches(rule, quote)).length }));
    standardsMetrics = {
      rules: rules.length,
      citations: citations.length,
      cited: cited.filter((entry) => entry.count > 0).sort((left, right) => right.count - left.count),
      neverCited: cited.filter((entry) => entry.count === 0).map((entry) => entry.rule),
      unmatchedCitations: [...new Set(citations.filter((quote) => !rules.some((rule) => matches(rule, quote))))].slice(0, TOP),
    };
  }

  return {
    reports: { total: reports.length, uniqueHeads: unique.length, repositories: [...new Set(unique.map((report) => report.repository))].sort() },
    pullRequests: {
      autoPass: unique.filter((report) => report.routing?.track === 'AUTO_PASS').length,
      aiTrack: unique.filter((report) => report.routing?.track === 'AI_TRACK').length,
      escalated: unique.filter((report) => report.routing?.track === 'ESCALATED').length,
    },
    files: {
      total: files.length,
      autoPass: count((file) => file.track === 'AUTO_PASS'),
      aiTrack: count((file) => file.track === 'AI_TRACK'),
      escalated: count((file) => file.track === 'ESCALATED'),
      autoPassRate: ratio(count((file) => file.track === 'AUTO_PASS'), files.length),
      escalationRate: ratio(count((file) => file.track === 'ESCALATED'), files.length),
      full: count((file) => file.fallback === 'FULL'),
      targeted: count((file) => file.fallback === 'TARGETED'),
    },
    oneWayDoors: top(triggered, Infinity),
    neverTriggered: [...doors].filter((code) => !triggered.includes(code)).sort(),
    fullReasons: top(needsReview.filter((file) => file.fallback === 'FULL').flatMap((file) => file.reasons.filter((reason) => !reason.startsWith('FACT_UNHANDLED')).map(reasonKey))),
    unhandledFactKinds: unhandledKinds,
    ai,
    human: {
      files: count((file) => file.needsHuman === true),
      findings: files.filter((file) => file.needsHuman).reduce((total, file) => total + (file.findings?.length ?? 0), 0),
      oneWayDoorFindings: files.reduce((total, file) => total + (file.findings ?? []).filter((finding) => finding.kind !== 'AI').length, 0),
      aiFindings: files.reduce((total, file) => total + (file.findings ?? []).filter((finding) => finding.kind === 'AI').length, 0),
    },
    standards: standardsMetrics,
    comments: comments === null ? null : {
      total: comments.length,
      topPaths: top(comments.map((comment) => comment.path).filter(Boolean), 5),
    },
    notAvailable: ['ACK_RATE', 'REOPENED_COUNT', 'DECLARED_VS_DETECTED'],
  };
}
