# PR-A — Semantic Fact Ingress

Status: `IMPLEMENTED`

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

## Next

PR-B 才實作真正 PHP/Laravel executable adapter 與第一批 deterministic semantic rules。
