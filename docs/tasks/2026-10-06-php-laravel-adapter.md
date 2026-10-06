# PR-B — Real PHP/Laravel Executable Adapter

Status: `IMPLEMENTED`

Base: PR-A `feat/semantic-fact-ingress`

## Goal

建立第一個真正執行 PHP 程式碼分析的 Adapter，將 PHP before/after source 轉成 PR-A 定義的 provider-neutral semantic facts。

## Scope

- Node adapter 透過 PHP CLI 執行 analyzer。
- Analyzer 使用 PHP 內建 `token_get_all(..., TOKEN_PARSE)`，不依賴 LLM 或 Composer parser。
- 支援第一批 deterministic facts：
  - `CALL_ARGUMENT_CHANGED`
  - `TRANSACTION_BOUNDARY_REMOVED`
  - `AUTHORIZATION_GUARD_REMOVED`
- Fact 保留 subject、properties、byte provenance 與 adapter source identity。
- 只有 analyzer 能證明所有 significant token change 都被支援的 fact 覆蓋時才回傳 `COMPLETE`。
- 無法完整解釋的 PHP change 一律回傳 `PARTIAL_PARSE` + `UNRECOGNIZED_PHP_CHANGE`。
- Parse error / analyzer failure fail-closed。
- 真實 PHP fact 仍由 PR-A interpreter boundary 決定是否形成 blocker；Adapter 不直接產生 Review decision。

## Supported completeness

目前可宣告 `COMPLETE`：

- significant token 不變的 formatting / comment-only change。
- named argument expression change，且遮罩已辨識 expression 後 before/after significant token signature 完全一致。
- 單純移除已辨識 authorize statement，且其餘 significant token 完全一致。

目前 transaction unwrap 會產生 fact，但保持 `PARTIAL_PARSE`，因為 v0.1 尚未證明 transaction closure body 與 unwrap 後 body 完全等價。

## Explicitly out of scope

- 完整 PHP AST / symbol solver。
- Laravel container resolution。
- Route / middleware / policy graph。
- Eloquent model semantic analysis。
- Risk / invariant domain policy。
- LLM。
- Mutation / Historical PR Evaluation。
- code-review-graph。

## Safety property

只要 PHP diff 中存在目前 analyzer 無法完整解釋的 significant token change，就不能產生 reduction success evidence。

## Next

後續 PR-C 建立 Mutation Evaluation Harness，開始量測 Critical Recall、False Negative Rate 與 Safe Reduction Rate。
