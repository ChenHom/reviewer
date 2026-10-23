# PR-A — Semantic Fact Ingress

Status: `IMPLEMENTED`

> 歷史紀錄：本文記錄 PR-A 合入 `master` 時（2026-10-06）的設計，之後不再更新。Fact contract、interpreter boundary 與 analysis context binding 的目前行為見 [README「已實作」](../../README.md#已實作) 與 [Current State](../current-state.md)。

## Goal

在既有 `AdapterResult → Safety MVP` pipeline 中加入 provider-neutral semantic Fact contract 與 fail-closed interpretation boundary，讓後續 PHP/Laravel Adapter 可以提供可追溯 facts，但 Adapter 本身不能取得 reduction decision 權限。

## Scope

- 新增 `semantic-facts` Adapter capability。
- 新增 semantic Fact envelope：
  - `id`
  - `kind`
  - `subject`
  - `properties`
  - `provenance`
  - `source.adapterId / source.adapterVersion`
- 重用既有 byte-range provenance 規則。
- Adapter 宣告 `semantic-facts` 時，`facts` 欄位必須存在。
- facts 經 validation 後做 deterministic normalization。
- 新增受信任 Fact Interpreter boundary。
- fact 沒有 interpreter 處理時產生 `FACT_UNHANDLED:<id>` blocker。
- interpreter exception / invalid result 產生 `ANALYZER_*` blocker並 fail-closed。
- 將 interpreter blocker 注入既有 `riskBlockers → eligibility → reducer` 流程。
- 舊 Adapter 未宣告 `semantic-facts` 時維持相容。

## Analysis Context Hardening

PR-A 同時負責 semantic fact ingress 的 authority / auditability 邊界：

- Fact `properties` 必須是 deterministic JSON-safe value。
- semantic facts canonicalize 後寫入 AnalysisContextBinding。
- 新增 `semanticFactsDigest`。
- Fact interpreter 必須提供 `id / version / interpret`，不接受裸 function。
- interpreter identity set 寫入 AnalysisContextBinding。
- 新增 `interpreterSetDigest`。
- `sameAnalysisContextBinding()` 同時比較 adapter、runtime、semantic facts 與 interpreter set。
- Candidate / Summary digest 對 semantic facts 與 fact assessment 敏感。

同一個 base/head SHA，只要 semantic fact payload 或 interpreter id/version 不同，就不得共用 authoritative analysis result。

## Explicitly out of scope

- PHP parser / AST analyzer。
- Laravel framework rules。
- Payment / transaction / authorization domain policy。
- LLM。
- Mutation Evaluation。
- Historical PR Evaluation。
- code-review-graph integration。

## Safety properties

1. Adapter 不得直接產生 `HUMAN_REVIEW_REQUIRED` 或 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
2. malformed fact 必須使 AdapterResult invalid。
3. unknown / unhandled fact 不得被忽略。
4. interpreter failure 不得視為「沒有風險」。
5. 增加 unresolved fact 不得讓 decision 變得更寬鬆。
6. 沒有 `semantic-facts` capability 的既有 Adapter 行為不變。
7. 非 JSON-safe Fact properties 必須 fail-closed。
8. facts payload 改變必須改變 analysis context。
9. interpreter id/version 改變必須改變 analysis context。
10. authority / candidate / Summary 必須綁定同一份完整 context binding。

## Next

PR-B 才實作真正 PHP/Laravel executable adapter 與第一批 deterministic semantic rules。
