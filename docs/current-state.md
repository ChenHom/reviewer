# Current State — Review Reduction Decision Engine

本文整理 2026-10-06 合入 `master` 的四個階段（PR-A～PR-D）、之後的擴充（PR #6 起：PHP-Parser AST analyzer、更多 facts 與 interpreters、PR review CLI、Real-repo evaluation），以及目前產品真正具備的能力、限制與下一步。

PR-A～PR-D 各段記錄合入當時的設計與數字，並註明之後的變化；標示「目前」的內容以目前的程式碼為準。

## 1. 實作階段

### PR-A — Semantic Fact Ingress + Analysis Context Hardening

目的：建立 Adapter 與 Review Decision Engine 之間的可信資料邊界。

已完成：

- `semantic-facts` Adapter capability。
- provider-neutral Fact envelope：
  - `id`
  - `kind`
  - `subject`
  - `properties`
  - byte provenance
  - source adapter identity/version
- Fact 未被 trusted interpreter 處理時，產生 `FACT_UNHANDLED:<id>`。
- interpreter exception / invalid output 採 fail-closed。
- Fact properties 必須是 deterministic JSON-safe value。
- semantic facts canonicalize 後綁入 `AnalysisContextBinding`。
- `semanticFactsDigest`。
- interpreter 必須是具 identity 的 descriptor：

```js
{
  id: 'payment-policy',
  version: '1.0.0',
  interpret(fact, context) {
    // ...
  }
}
```

- `interpreterSetDigest`。
- Candidate / Summary digest 對 facts 與 fact assessment 敏感。

因此以下兩種情況都不得共用 authoritative result：

```
相同 base/head SHA + 不同 semantic facts
相同 base/head SHA + 不同 interpreter id/version
```

### PR-B — Real PHP/Laravel Adapter + Deterministic Interpreters

目的：開始從真實程式碼產生 machine facts，而不是只使用 fixture。

PR-B 完成時的架構（之後 analyzer 已改用 nikic/php-parser AST，見下方「PR #6 起」）：

```
Node Reviewer
    │
    ├─ spawn PHP CLI
    ▼
PHP Analyzer
    │ token_get_all(..., TOKEN_PARSE)
    ▼
Generic Semantic Facts
    ▼
PHP/Laravel Domain Interpreters
```

PR-B 完成時 Adapter 輸出的 generic facts（之後 analyzer 已改用 PHP-Parser AST，並增加運算子、guard、陣列元素、字面值、條件反轉、回傳值、參數順序、變數等 facts；目前完整清單見 [README「已實作」](../README.md#已實作)）：

- `CALL_ARGUMENT_CHANGED`
- `CALL_REMOVED`
- `CALL_ADDED`

Domain interpreter 再把 generic facts 解讀成 domain blockers。PR-B 完成時的三個 interpreter：

```
CALL_ARGUMENT_CHANGED
argument=idempotencyKey
        ↓
PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED
```

```
CALL_REMOVED
callee=DB::transaction
        ↓
TRANSACTION_BOUNDARY_REMOVED
```

```
CALL_REMOVED
callee=$this->authorize / Gate::authorize
        ↓
AUTHORIZATION_GUARD_REMOVED
```

之後 interpreter 已從 3 個擴充為 15 個（`PHP_LARAVEL_DOMAIN_INTERPRETERS`）：原本三個中，transaction boundary 與 authorization guard 也擴大了範圍（例如 `rollBack` 移除 → `TRANSACTION_ROLLBACK_REMOVED`、authorize 的 ability 字串改值 → `AUTHORIZATION_ABILITY_CHANGED`），另新增 middleware guard、row lock、payment signature verification、運算子、guard clause、運算式反轉、回傳值、參數順序、改用另一個變數（部分改名、合併變數）/ 參數改名、`const` 宣告的常數改值、Laravel validation rules、Laravel model attributes。各 interpreter 的範圍見 [README「已實作」](../README.md#已實作)；完整的 blocker 代碼以 `src/interpreters/php-laravel-domain.js` 為準。

這個分層很重要：

> Adapter 描述「發生了什麼」；Interpreter 才描述「這件事對 Review policy 代表什麼」。

Adapter 不直接輸出 `HUMAN_REVIEW_REQUIRED` 或 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

### PR-C — Mutation Evaluation Harness

目的：避免只靠「CI 綠」宣稱安全，而是直接量測 reduction safety。

PR-C 完成時 corpus 包含 6 個 case：

Critical：

- Payment idempotency argument change。
- Transaction boundary removed。
- Authorization guard removed。
- wallet condition `< → <=` 的 unsupported mutation（當時 analyzer 沒有對應的 fact，只能靠 fail-closed fallback；現在由 `BINARY_OPERATOR_CHANGED` → `COMPARISON_OPERATOR_CHANGED` 直接解釋）。

Safe：

- formatting/comment-only。
- local variable rename（當時不支援，預期仍要求 Human Review；現在由 scope-aware 區域變數改名判為等價，可以 reduction）。

每個 case 都走 production pipeline：

```
PHP Adapter
→ Fact Ingress
→ Production Domain Interpreters
→ Coverage
→ Eligibility
→ Reducer
```

PR-C 完成時 baseline：

```
Critical Recall               100.0%
False Negative Rate             0.0%
Critical Direct Fact Coverage  75.0%
Safe Reduction Rate            50.0%
Partial Coverage Rate          50.0%
Analysis Failure Rate           0.0%
Full Review Fallback Rate      50.0%
```

當時的解讀：

- curated critical mutation 沒有 false negative。
- 25% critical case（wallet `< → <=`）是靠 fail-closed fallback，而不是 analyzer 直接理解。
- safe case 只有一半能 reduction。
- 保守性仍高，不能只看 Critical Recall = 100%。

目前 corpus（`evaluation/mutations/cases.json`）有 20 個 case：

- Critical 16 個（MUT-001～MUT-016）：除了上述 4 個，另有 `\DB::transaction` wrapper 移除、`\DB::beginTransaction` / `\DB::commit` 移除（`TRANSACTION_BOUNDARY_REMOVED`）、`\DB::rollBack` 移除（`TRANSACTION_ROLLBACK_REMOVED`）、transaction closure 內鏈式 `lockForUpdate()` 移除（`ROW_LOCK_REMOVED`）、callback 簽章驗證 guard 移除（`SIGNATURE_VERIFICATION_REMOVED`）、`Route::group` / controller constructor / `$beforeActionList` 中的 middleware 或 authorize 移除（`MIDDLEWARE_GUARD_REMOVED`）、扣款 `-` → `+`（`ARITHMETIC_OPERATOR_CHANGED`）、簽章檢查保留但 throw guard 被移除（`GUARD_CLAUSE_REMOVED`）、method 參數一致改名（`PARAMETER_RENAMED`）、兩個區域變數合併成一個（`VARIABLE_REFERENCE_CHANGED`）。
- Safe 4 個（SAFE-001～SAFE-004）：formatting/comment-only、區域變數改名、`\DB::transaction` closure 內的註解與換行、`array()` → `[]` / 引號 / 多餘括號 / trailing comma。

目前 baseline（`npm run eval:mutations`，與 [README「目前驗證基準」](../README.md#目前驗證基準) 相同）：

```
Critical Recall               100.0%
False Negative Rate             0.0%
Critical Direct Fact Coverage 100.0%
Safe Reduction Rate           100.0%
Partial Coverage Rate          15.0%
Analysis Failure Rate           0.0%
Full Review Fallback Rate      15.0%
```

目前解讀：

- 16 個 critical case 都要求 Human Review，而且都有 analyzer 直接產生的 fact（fallback-only 為 0）。
- 4 個 safe case 全部 reduction。
- 3 個 critical case 雖然有具體 blocker，但還有無法解釋的差異（`COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`），所以走 `FULL`：MUT-002、MUT-005（移除 transaction wrapper 後，closure body 移到外層）與 MUT-013（移除 throw guard 後，驗證呼叫留成單獨的 statement）。這就是 15% 的 Partial Coverage / Full Review Fallback。
- corpus 仍是少量 curated mutation，Critical Recall = 100% 不代表真實世界沒有 false negative。

### PR-D — Historical PR Evaluation

目的：驗證 reduction 是否仍覆蓋實際 Human Review concern。

Snapshot manifest 包含：

- repository
- base SHA
- head SHA
- changed files before/after
- human concern ground truth

重要規則：

> `humanConcerns` 只在分析完成後比較，絕不傳入 Adapter / Interpreter，避免 ground-truth leakage。

目前指標：

- Human Concern Recall
- Review Scope Reduction
- Analysis Failure Rate
- Full Review Rate

CI pilot：

```
Changed files                3
Selected files               2
Human concerns               2
Human concerns covered       2
Human concerns missed        0

Human Concern Recall        100.0%
Review Scope Reduction       33.3%
Analysis Failure Rate         0.0%
Full Review Rate              0.0%
```

目前 pilot 仍只有 1 個 controlled fixture case（`evaluation/historical/cases/pilot.json`），只證明 evaluation wiring 正常。下一步應加入真正 Historical PR snapshots。

### PR #6 起 — PHP-Parser AST Analyzer、PR Review CLI、Real-repo Evaluation

PR #6（2026-10-07 合入 `master`）與之後的改動。

AST analyzer（`analyzers/php/bin/analyze.php`、`analyzers/php/src/`）：

- 改用 [nikic/php-parser](https://github.com/nikic/PHP-Parser) 5.9.0（`composer.lock` 鎖定版本）解析 AST，取代 `token_get_all`。執行需要 PATH 上的 `php`（PHP CLI ≥ 8.3，CI 使用 8.4）；依賴以 `npm run analyzer:install`（Composer 2）安裝，缺少時以 `PHP_ANALYZER_DEPENDENCY_MISSING` fail-closed。
- 被分析的程式碼先以最新 PHP 語法解析，任一側失敗時 before / after 一起改用 PHP 7.4 語法；仍無法解析時回報 `PHP_PARSE_ERROR`。
- completeness 由 AST 結構比對決定：排版、註解、引號、`array()` / `[]`、多餘括號、trailing comma 不算差異；其餘每個差異都必須由 fact 解釋，否則回報 `COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`，fail-closed。
- method / function 內一致的區域變數改名以 scope-aware 方式判為等價（例外情況見 README「已實作」）。判為等價前同時檢查 PHP 8 與 PHP 7 的解讀，不一致時回報 `PHP_GRAMMAR_DIVERGENCE`。
- 新增 10 種 generic facts：`BINARY_OPERATOR_CHANGED`、`GUARD_REMOVED` / `GUARD_ADDED`、`ARRAY_ITEM_REMOVED` / `ARRAY_ITEM_ADDED`、`LITERAL_CHANGED`、`EXPRESSION_NEGATED`、`RETURN_VALUE_CHANGED`、`CALL_ARGUMENTS_REORDERED`、`VARIABLE_CHANGED`。interpreter 從 3 個增加到 15 個（見上方 PR-B 段落）。

PR review CLI（`bin/review.js`，用法、選項、exit code、原因代碼、文字與 JSON 報表見 [PR Review CLI](review-cli.md)）：

- `node bin/review.js --base <ref> [--head HEAD] [--repo .]`。與 GitHub PR 相同，比較的是 head 相對於 `git merge-base <base> <head>` 的變更：base 分支在 head 分出後的新 commit 不會列入。
- 每個變更檔案逐一決策。只有 `.php` 的修改與 rename 會送進 analyzer；新增、刪除、非 PHP、binary、symlink、submodule 檔案一律 `FULL`。rename 與權限變更即使內容等價也要求 review。
- 需要 review 的檔案分成兩種。`TARGETED`：檔案中每一處變更都已被具體 fact 解釋（或檔案只是 rename / 權限變更），列出的原因與位置是 review 的起點。`FULL`：有變更無法被解釋、analyzer 失敗，或檔案沒有送進 analyzer。兩者都仍需 review 整個檔案，reduction 是 file-level。
- PR 層級的決策只有在**所有**檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

Real-repo evaluation（`evaluation/real-repo/`，說明見 [Real-repo Evaluation](../evaluation/real-repo/README.md)）：

- `npm run eval:real-repo -- evaluate --repo <label>=<path> ...` 在真實 PHP 專案的檔案上自動產生帶標籤的 mutation（`unchanged` / `safe` / `risky`），走完整 pipeline（PHP analyzer → interpreters → reducer），再檢查決策是否符合標籤。另有 `generate` / `run` / `report` / `compare` / `inspect` 子指令；`--baseline-ref` 可與修改前的版本比較。
- Gate 任一項不為 0 即失敗：`RISKY_REDUCED`（risky mutation 被判為 `NOT_SELECTED_FOR_HUMAN_REVIEW`）、`ANALYZER_ERROR`（analyzer crash、逾時或 pipeline 例外）、`UNCHANGED_NOT_REDUCED`（可解析的未變更檔案沒有被 reduce）、`NO_ROWS_ANALYZED` / `REPO_NOT_ANALYZED`（沒有資料，或某個 repo 沒有資料被實際分析）。
- 最近一次在本機對兩個私有 PHP 金流專案與一個 Laravel 11 專案執行（seed 42、rate 0.3）：12,283 筆（3,093 unchanged、3,648 safe、5,542 risky），Risky reduced 0、Risky targeted rate 99.3%、Risky specific reason rate 53.4%、Safe reduction rate 100.0%、Unchanged reduction rate 99.9%（未被 reduce 的 3 筆都是空檔）。
- 目標專案不在本 repo 內，這些數字無法只靠本 repo 重現；對真實目標專案執行的 Real-repo evaluation 不在 `npm run test:all` 與 CI 中，不屬於 release gate（`npm run test:all` 只以 `tests/evaluation/real-repo-*.test.js` 在 repo 內的 `fixtures/php-laravel` 與測試自建的小型 PHP 檔上測試這個工具本身與 gate）。資料是在真實程式碼上自動產生的 mutation，不是真實 PR 的 human concern。

CI（`.github/workflows/review-reduction-safety.yml`，PHP 8.4）在 `npm run test:all` 之前先執行 `composer install --working-dir=analyzers/php`，並對 `analyzers/php/bin`、`analyzers/php/src` 與 `evaluation` 下的 `.php` 檔執行 `php -l`。

## 2. 現在的完整 Pipeline

```
PR review CLI（bin/review.js）的入口步驟：
  git merge-base(base, head) → git diff -M <merge base> <head>
  ↓
逐檔分類
  ├─ 新增 / 刪除 / 非 PHP / binary / symlink / submodule 等 → FULL（不分析）
  └─ .php 的修改 / rename
  ↓
PHP/Laravel Adapter（nikic/php-parser AST）
（evaluation harness 與 runStoredAdapterPipeline 不經過上面的 CLI 步驟，直接從 Adapter 開始）
  ├─ changed regions
  ├─ runtime context
  └─ semantic facts
  ↓
AnalysisContextBinding
  ├─ adapterSetDigest
  ├─ executionContextDigest
  ├─ semanticFactsDigest
  └─ interpreterSetDigest
  ↓
Domain Interpreters
  ↓
Coverage / Evidence / Impact / Invariants / Risk Blockers
  ↓
Eligibility
  ↓
Review Scope Reducer
  ↓
HUMAN_REVIEW_REQUIRED（TARGETED / FULL）
或
NOT_SELECTED_FOR_HUMAN_REVIEW
  ↓
  ├─ PR review CLI：內容等價（原本 NOT_SELECTED）的 rename / 權限變更改為 TARGETED，
  │  已需要 review 的 rename / 權限變更檔案只附加 FILE_RENAMED / FILE_MODE_CHANGED
  │  （TARGETED / FULL 不變）；彙整成 PR 層級決策
  │  （所有檔案都 NOT_SELECTED 才 NOT_SELECTED）→ 文字 / JSON 報表
  └─ runStoredAdapterPipeline：CAS Authority → Summary / Status Check
     （GitHub transport 需注入；目前只有測試呼叫，沒有 CLI 或 workflow 使用）
```

## 3. 目前 Safety Invariants

1. `NOT_SELECTED_FOR_HUMAN_REVIEW` 只能來自完整有效分析。
2. Unknown != Safe。
3. `PARTIAL_PARSE`、timeout、unsupported、truncation、analyzer failure 不能被視為沒有風險。
4. Adapter 不能直接決定 Review outcome。
5. Fact interpreter 未處理的 fact 不得靜默消失。
6. Facts / interpreter identity 都是 analysis context 的一部分。
7. 新 head SHA 必須使舊結果 stale。
8. 舊 run 不得覆寫新 authoritative result。
9. Summary 必須綁定 authoritative candidate。
10. Evaluation 中 critical false negative 必須使 gate fail。
11. PR 層級只有在所有變更檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才能 reduction；沒有送進 analyzer 的檔案與 rename / 權限變更一律要求 review。

## 4. 目前適合拿來做什麼

現階段適合：

- PHP/Laravel PR 的 deterministic fact extraction（PHP-Parser AST）。
- 對支援的 semantic change 做 fail-closed Review selection。
- 建立 file-level Review Scope。
- 以 `node bin/review.js` 對一個 PR（head 相對於 merge base 的變更）逐檔列出（見 [PR Review CLI](review-cli.md)）：
  - 哪些檔案需要 Human Review：`TARGETED` / `FULL`、原因代碼與變更位置。位置只是 review 的起點，整個檔案仍需 review。
  - 哪些檔案沒有被選入 Human Review。
  - 需要 review 的檔案數 / 變更檔案總數，以及 `TARGETED` / `FULL` 的數量。
  - JSON 報表與 `--fail-on-review` 可以放進 CI；本 repo 的 CI 目前沒有執行這一步。
- 用 mutation / historical corpus（`npm run test:all` 與 CI 的 gate）與 real-repo evaluation（本機，需要目標專案）持續校準 reduction safety。

目前不應宣稱：

- 能做 symbol solving / 型別推論。analyzer 已用 nikic/php-parser 解析完整 AST 並以結構比對判定 completeness，但 callee 只以原始碼中的名稱文字比對（interpreter 只去掉前導 `\`），不解析 `use` 別名、namespace、變數型別、繼承或動態呼叫。例如 `use Illuminate\Support\Facades\Gate as G;` 之後移除 `G::authorize(...)` 不會被辨識為 `AUTHORIZATION_GUARD_REMOVED`，只會是 `FACT_UNHANDLED`（仍要求 review）。
- 能分析跨檔案影響。每個檔案獨立分析，沒有 call graph；pipeline 的 Impact 層只驗證外部提供的 impact graph，目前沒有任何 adapter / provider 產生（見 §5 第 8 項）。
- 能理解所有 Laravel runtime behavior。
- 能安全處理所有語言。只有 PHP 檔會被分析，其他檔案一律 `FULL`。
- 已有真實世界 false-negative 保證。mutation corpus 是 curated case；real-repo evaluation 是在真實程式碼上自動產生的 mutation，不是真實 PR；historical evaluation 仍是 controlled fixture pilot。
- 能做成熟的 line-level / region-level review reduction。`TARGETED` 列出的位置只是起點，整個檔案仍需 review。
- 已能在 GitHub PR 上自動發布 Summary / Check。目前只有 provider-neutral sink boundary（需注入 transport），沒有 workflow 執行 review。

## 5. 接下來優先順序

優先順序應以「提高 reduction，但不傷害 critical recall」為核心：

```
1. 真實 Historical PR corpus（目前只有 1 個 controlled fixture pilot）
2. 擴大 PHP/Laravel analyzer coverage（已改用 nikic/php-parser AST，並新增 10 種 generic facts）
3. 增加 deterministic domain interpreters（目前 15 個；real-repo 的 Risky specific reason rate 為 53.4%，
   其餘 risky 變更只有 FACT_UNHANDLED 等 generic 原因）
4. multi-file Review Plan / CLI（bin/review.js 已提供 PR 層級的逐檔決策與位置提示；
   各檔案仍獨立分析，尚無跨檔案的 Review Plan）
5. GitHub PR workflow
6. Harness integration
7. region-level selection
8. optional impact provider / code-review-graph
9. 最後才考慮 LLM hypothesis layer
```

核心目標函數：

```
maximize Review Scope Reduction
subject to Critical False Negative ≈ 0
```

不能反過來為了 reduction 數字，降低 fail-closed 邊界。
