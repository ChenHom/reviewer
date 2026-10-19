/**
 * Retro 的 markdown 報告（可直接貼到 `$GITHUB_STEP_SUMMARY` 或 PR 說明）。
 */

/**
 * 百分比文字。
 *
 * @param {number|null} value - 0..1。
 * @returns {string} 文字。
 */
function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * markdown 表格中的文字（跳脫 `|` 並壓成一行）。
 *
 * @param {unknown} value - 文字。
 * @returns {string} 安全的儲存格內容。
 */
function cell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * 計數清單的表格；沒有資料時為一行說明。
 *
 * @param {string} heading - 欄位名稱。
 * @param {Array<{code: string, count: number}>} rows - 計數。
 * @returns {string[]} 文字行。
 */
function countTable(heading, rows) {
  if (rows.length === 0) return ['（沒有）'];
  return [`| ${heading} | 次數 |`, '|---|---|', ...rows.map((row) => `| \`${cell(row.code)}\` | ${row.count} |`)];
}

const NOT_AVAILABLE = Object.freeze({
  ACK_RATE: '豁免率（人工確認後放行的比例）',
  REOPENED_COUNT: '豁免後又被修改（REOPENED）的次數',
  DECLARED_VS_DETECTED: 'PR 自我宣告的風險與偵測結果不一致的次數',
});

/**
 * Retro 報告。
 *
 * @param {object} metrics - computeRetroMetrics() 的結果。
 * @param {object|null} [proposals=null] - proposeImprovements() 的結果。
 * @returns {string} markdown。
 */
export function formatRetro(metrics, proposals = null) {
  const { files, pullRequests: prs } = metrics;
  const lines = [
    '# Reviewer Retro',
    '',
    `報表 ${metrics.reports.total} 份（不同的 head ${metrics.reports.uniqueHeads} 個${metrics.reports.repositories.length > 0 ? `；${metrics.reports.repositories.join('、')}` : ''}）、檔案 ${files.total} 個。`,
    '',
    '## 路由',
    '',
    '| | 檔案 | PR |',
    '|---|---|---|',
    `| AUTO_PASS（不需要 review） | ${files.autoPass}（${percent(files.autoPassRate)}） | ${prs.autoPass} |`,
    `| AI_TRACK（由 AI 判斷） | ${files.aiTrack} | ${prs.aiTrack} |`,
    `| ESCALATED（單向門，必須人工） | ${files.escalated}（${percent(files.escalationRate)}） | ${prs.escalated} |`,
    '',
    `需要 review 的檔案中 TARGETED ${files.targeted}、FULL ${files.full}。`,
    '',
    '## 單向門',
    '',
    ...countTable('原因', metrics.oneWayDoors),
    '',
    `這段期間沒有觸發的單向門（${metrics.neverTriggered.length}）：${metrics.neverTriggered.length > 0 ? metrics.neverTriggered.map((code) => `\`${code}\``).join('、') : '（沒有）'}。長期沒有觸發的專案規則可以考慮精簡；預設單向門保留。`,
    '',
    '## 機械審查無法解釋的原因（FULL）',
    '',
    '強化 analyzer 的優先順序：出現越多，越值得讓 analyzer 能以 fact 解釋。',
    '',
    ...countTable('原因', metrics.fullReasons),
    '',
    '## 沒有 domain 規則的 fact（FACT_UNHANDLED）',
    '',
    '新 interpreter、preset 或 `.reviewer.json` 規則的候選。',
    '',
  ];
  if (metrics.unhandledFactKinds.length === 0) {
    lines.push('（沒有）');
  } else {
    lines.push('| fact | 次數 | 例子 |', '|---|---|---|');
    for (const entry of metrics.unhandledFactKinds) lines.push(`| \`${entry.kind}\` | ${entry.count} | ${entry.examples.map(cell).join('<br>')} |`);
  }

  lines.push('', '## AI 審查', '');
  if (metrics.ai === null) {
    lines.push('這段期間的報表沒有 AI 審查（沒有使用 `--ai`）。');
  } else {
    const { ai } = metrics;
    lines.push(
      `交給 AI ${ai.files} 個檔案：未發現問題 ${ai.pass}、需要人工 ${ai.needsHuman}、已修正 ${ai.fixed}、失敗 ${ai.failed}；AI_TRACK 中 AI 放行（含修正）的比例 ${percent(ai.aiTrackClearRate)}；由備援模型回答 ${ai.fallbackUsed} 個。`,
      '',
      `token：輸入 ${ai.usage.inputTokens ?? 0}、輸出 ${ai.usage.outputTokens ?? 0}、cache 讀取 ${ai.usage.cacheReadInputTokens ?? 0}、cache 寫入 ${ai.usage.cacheCreationInputTokens ?? 0}。`,
      '',
      'AI 失敗的原因：',
      '',
      ...countTable('原因', ai.failureReasons),
    );
  }

  lines.push('', '## 人工', '', `需要人工的檔案 ${metrics.human.files} 個、待確認項目 ${metrics.human.findings} 項（單向門 ${metrics.human.oneWayDoorFindings}、AI ${metrics.human.aiFindings}）。`);
  if (metrics.comments) {
    lines.push('', `人工留言 ${metrics.comments.total} 則。`, '', ...countTable('檔案', metrics.comments.topPaths));
  }

  if (metrics.standards) {
    const { standards } = metrics;
    lines.push('', '## codingstandards.md', '', `條目 ${standards.rules} 條，AI 疑慮引用 ${standards.citations} 次。`, '');
    if (standards.cited.length > 0) {
      lines.push('| 條目 | 引用 |', '|---|---|', ...standards.cited.map((entry) => `| ${cell(entry.rule)} | ${entry.count} |`), '');
    }
    lines.push(`沒有被引用的條目（${standards.neverCited.length}）：精簡的候選。`, ...standards.neverCited.map((rule) => `- ${rule}`));
    if (standards.unmatchedCitations.length > 0) {
      lines.push('', 'AI 引用但對不到任何條目的文字（可能是規範需要補上，或 AI 引用錯誤）：', ...standards.unmatchedCitations.map((quote) => `- ${quote}`));
    }
  }

  lines.push('', '## 需要 GitHub 整合（設計的步驟 7）才有的指標', '', ...metrics.notAvailable.map((code) => `- ${NOT_AVAILABLE[code] ?? code}`));

  if (proposals) lines.push('', ...proposalLines(proposals));
  return `${lines.join('\n')}\n`;
}

/**
 * AI 建議的段落。
 *
 * @param {object} proposals - proposeImprovements() 的結果。
 * @returns {string[]} 文字行。
 */
function proposalLines(proposals) {
  const lines = ['## 建議（AI 草案，請人工審核後以 PR 提出）', ''];
  if (!proposals.ok) {
    lines.push(`AI 建議失敗：\`${proposals.error}\`。`);
    return lines;
  }
  lines.push(`${proposals.summary}${proposals.fallback ? `（由備援模型 ${proposals.model} 回答）` : ''}`, '');
  lines.push('### codingstandards.md：新增', '');
  if (proposals.standardsAdditions.length === 0) lines.push('（沒有）');
  for (const item of proposals.standardsAdditions) lines.push(`- **${item.rule}** — ${item.rationale}（依據：${item.evidence}）`);
  lines.push('', '### codingstandards.md：刪除', '');
  if (proposals.standardsRemovals.length === 0) lines.push('（沒有）');
  for (const item of proposals.standardsRemovals) lines.push(`- ~~${item.rule}~~ — ${item.rationale}`);
  lines.push('', '### .reviewer.json 規則', '');
  if (proposals.configRules.accepted.length + proposals.configRules.rejected.length === 0) lines.push('（沒有）');
  for (const item of proposals.configRules.accepted) lines.push(`- ✅ \`${item.section}\`：\`${cell(JSON.stringify(item.entry))}\` — ${item.rationale}`);
  for (const item of proposals.configRules.rejected) lines.push(`- ❌ \`${item.section}\`：\`${cell(item.rule)}\`（無效：${item.errors.join(', ')}）`);
  lines.push('', '### mutation case 草案', '', '「通過」表示以加入上述規則後的設定執行機械審查，產生了預期的原因代碼；新規則必須有通過的 case 才能合併。', '');
  if (proposals.mutationCases.length === 0) lines.push('（沒有）');
  for (const draft of proposals.mutationCases) {
    const { verification } = draft;
    const status = verification.verified
      ? '✅ 通過'
      : `❌ 未通過（${verification.error ?? `實際：${verification.track}，${verification.reasons.join(', ') || '沒有原因'}`}）`;
    lines.push(`- \`${draft.path}\` 預期 \`${draft.expectedReason}\`：${status} — ${draft.description}`);
  }
  return lines;
}
