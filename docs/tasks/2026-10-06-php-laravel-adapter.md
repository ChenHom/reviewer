# PR-B — Real PHP/Laravel Executable Adapter

Status: `IMPLEMENTED`

> 歷史紀錄：本文記錄 PR-B 合入 `master` 時（2026-10-06）的設計，之後不再更新。之後 analyzer 已改用 [nikic/php-parser](https://github.com/nikic/PHP-Parser) 5.9.0（Composer 依賴，`composer.lock` 鎖定版本）解析 AST 並做結構比對，不再使用 `token_get_all`；第一次執行前要先跑 `npm run analyzer:install`，缺少依賴時以 `PHP_ANALYZER_DEPENDENCY_MISSING` fail-closed。下文「Scope」與「Safety property」中的 significant token 比對、「Supported completeness」中的遮罩規則、「Deterministic Domain Interpreters」中只有三個 interpreter 的清單（目前有 15 個），以及「Explicitly out of scope」中的「完整 PHP AST」，都是當時的狀態。目前的 facts、interpreters 與安裝方式見 [README「已實作」](../../README.md#已實作)、[README「Release gate」](../../README.md#release-gate) 與 [Current State](../current-state.md)；PR review CLI 回報的 analyzer 原因代碼見 [PR Review CLI](../review-cli.md#原因代碼)。

Base: PR-A `feat/semantic-fact-ingress`

## Goal

建立第一個真正執行 PHP 程式碼分析的 Adapter，將 PHP before/after source 轉成 PR-A 定義的 provider-neutral semantic facts。

## Scope

- Node adapter 透過 PHP CLI 執行 analyzer。
- Analyzer 當時使用 PHP 內建 `token_get_all(..., TOKEN_PARSE)`，不依賴 LLM 或 Composer parser。
- 支援第一批 deterministic facts：
  - `CALL_ARGUMENT_CHANGED`
  - `CALL_REMOVED`
  - `CALL_ADDED`
- Fact 保留 subject、properties、byte provenance 與 adapter source identity。
- 當時只有 analyzer 能證明所有 significant token change 都被支援的 fact 覆蓋時才回傳 `COMPLETE`。
- 無法完整解釋的 PHP change 當時一律回傳 `PARTIAL_PARSE` + `UNRECOGNIZED_PHP_CHANGE`（之後另有 `PHP_GRAMMAR_DIVERGENCE`，見「Supported completeness」的註）。
- Parse error / analyzer failure fail-closed。
- 真實 PHP fact 仍由 PR-A interpreter boundary 決定是否形成 blocker；Adapter 不直接產生 Review decision。

## Supported completeness

PR-B 合入時（`token_get_all` 遮罩版）可宣告 `COMPLETE`：

- significant token 不變的 formatting / comment-only change。
- named argument expression change，且遮罩已辨識 expression 後 before/after significant token signature 完全一致。
- 單純新增或移除可辨識的 standalone call statement，且遮罩後其餘 significant token 完全一致。

> 註：之後 analyzer 已改用 nikic/php-parser 5.9.0 的 AST，`COMPLETE` 改由 AST 結構比對判定：排版、註解、trailing comma、引號種類、`array()` / `[]`、多餘括號，以及 method / function 內一致的區域變數改名（有例外）都視為等價；其餘每個差異都必須由 fact 解釋。無法被更細 fact 解釋的位置參數改變會以 `#index` 輸出 fallback `CALL_ARGUMENT_CHANGED`，但不算已解釋。沒有 fact 的 `COMPLETE` 還要確認最新 PHP 語法與 PHP 7.4 語法的解讀一致，否則以 `PARTIAL_PARSE` + `PHP_GRAMMAR_DIVERGENCE` 回報。fact 種類也已增加（運算子、guard、陣列元素、字面值、條件反轉、回傳值、參數順序、變數等），並會抽出 closure 內的巢狀 call 與鏈式 call。目前行為與完整 fact 清單見 [README「已實作」](../../README.md#已實作)。

例如 `DB::transaction(...)` wrapper 被移除時，Adapter 只輸出 generic `CALL_REMOVED`。若 unwrap 後 closure body 仍存在，遮罩後 signature 不相等，因此保持 `PARTIAL_PARSE`（AST 版中，移到外層的 closure body 是沒有 fact 能解釋的結構差異，結果同樣是 `PARTIAL_PARSE` + `UNRECOGNIZED_PHP_CHANGE`）。`DB::transaction` 或 `authorize` 的 domain 意義由後續 interpreter 決定。

## Deterministic Domain Interpreters

PR-B 同時包含第一批 deterministic domain interpreters；Adapter 仍只輸出 generic facts：

- `CALL_ARGUMENT_CHANGED` + `argument=idempotencyKey`
  → `PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED`
- `CALL_REMOVED` + `callee=DB::transaction`
  → `TRANSACTION_BOUNDARY_REMOVED`
- `CALL_REMOVED` + `callee=$this->authorize / Gate::authorize`
  → `AUTHORIZATION_GUARD_REMOVED`

Interpreter 皆提供穩定 `id/version/interpret`，並由 PR-A 的 AnalysisContextBinding 綁定；未知 generic fact 不會被 interpreter 吞掉，仍然 fail-closed 為 `FACT_UNHANDLED`。

## Explicitly out of scope

- 完整 PHP AST / symbol solver。
- Laravel container resolution。
- Route / middleware / policy graph。
- Eloquent model semantic analysis。
- 更完整的 domain policy / invariant registry。
- LLM。
- Mutation / Historical PR Evaluation。
- code-review-graph。

## Safety property

只要 PHP diff 中存在目前 analyzer 無法完整解釋的 significant token change，就不能產生 reduction success evidence。

## Next

後續 PR-C 建立 Mutation Evaluation Harness，開始量測 Critical Recall、False Negative Rate 與 Safe Reduction Rate。
