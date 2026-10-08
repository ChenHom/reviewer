# Reviewer — Review Reduction Decision Engine

Reviewer 是一個 deterministic、fail-closed 的 Review Decision Engine。

它的目標不是「替人做完整 Code Review」，而是回答更窄、也更可驗證的問題：

> 在目前可觀測、可驗證的證據下，哪些變更可以安全地 **不選入人工 Review**，哪些仍必須交給人看？

核心決策只有兩類：

```
HUMAN_REVIEW_REQUIRED
NOT_SELECTED_FOR_HUMAN_REVIEW
```

其中 `NOT_SELECTED_FOR_HUMAN_REVIEW` 不是「程式一定沒問題」，而是：

- 分析完整；
- 必要 coverage 完整；
- 沒有 unresolved blocker；
- 沒有 policy / audit 要求人工作業；
- 分析結果與 base/head SHA、Adapter、facts、interpreter identity 完整綁定。

任何 unknown / incomplete / analyzer failure 都採 fail-closed，不能被解讀成安全。

## Current pipeline

```
Git / before-after source
        ↓
Language / Framework Adapter
        ↓
Provider-neutral Semantic Facts
        ↓
Deterministic Domain Interpreters
        ↓
Coverage / Evidence / Impact / Invariants
        ↓
Eligibility
        ↓
Review Scope Reducer
        ↓
HUMAN_REVIEW_REQUIRED
或
NOT_SELECTED_FOR_HUMAN_REVIEW
        ↓
Authoritative Candidate / Summary / Check
```

目前第一個 executable Adapter 是 PHP/Laravel。

## Review 一個 PR

需要 Node.js（CI 使用 24）、`git`、PATH 上的 `php`（PHP CLI ≥ 8.3，CI 使用 8.4）與 Composer 2；完整前置需求見 [Review CLI](docs/review-cli.md#前置需求)。這是執行 analyzer 的 PHP 版本，與被分析專案的目標版本無關：被分析的程式碼以最新語法或 PHP 7.4 語法解析，判為等價前只檢查 PHP 7 與 PHP 8 的解讀，PHP 5 的語意不在檢查範圍；兩種語法都無法解析時為 `FULL`（`PHP_PARSE_ERROR`），見「已實作」。

```bash
npm run analyzer:install   # 第一次需要安裝 PHP analyzer 依賴（執行 composer install）

node bin/review.js --repo /path/to/project --base origin/master --head HEAD
```

與 GitHub PR 相同，比較的是 head 相對於 `git merge-base <base> <head>` 的變更：base 分支在 head 分出後的新 commit 不會被列入；兩者沒有共同歷史（或 shallow clone 中缺少 merge base，例如 CI 的 `fetch-depth: 1`）時以 `GIT_NO_MERGE_BASE` 結束（exit code 2）。每個變更檔案逐一決策，列出需要 Human Review 的檔案、原因與行號：

```
Review：HUMAN_REVIEW_REQUIRED（3/4 個檔案需要 review；TARGETED 2、FULL 1）
project  origin/master (6af59df90c81) → HEAD (56fd3599cc75)，比較起點為 merge base 895b1d0a2b2b

需要 review：
  FULL     composer.json
           - UNSUPPORTED_FILE_TYPE（非 PHP 檔案，未分析）
           變更位置：head:L5
  TARGETED app/Services/FreezeService.php
           - COMPARISON_OPERATOR_CHANGED
           變更位置：head:L9
           · head:L9 運算子 < → <=：$cash->amount < $amount → $cash->amount <= $amount
  TARGETED app/Services/OrderService.php
           - FACT_UNHANDLED ×2（有變更但沒有對應的 domain 規則，請看標示位置）
           變更位置：head:L11
           · head:L11 新增呼叫 ->firstOrFail
           · base:L11 移除呼叫 ->first

不需要 review（1）：
  app/Entities/Observers/FreezeObserver.php
```

第二行是 repository 與 base / head 的 ref 和 commit；merge base 不是 base 的 commit 時（base 分支之後又有新 commit），會另外標出實際的比較起點。

- `FULL`：有無法以 fact 解釋的變更（例如 `COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`）、analyzer 失敗，或檔案沒有送進 analyzer。需完整 review 該檔案。
- `TARGETED`：每一處程式碼變更都已被 fact 解釋（或檔案只是 rename / 權限變更）；解釋變更的 fact 不一定有對應的 domain 規則，見下方 `FACT_UNHANDLED`。列出的原因與位置是 review 的起點，**整個檔案仍需 review**（reduction 是 file-level，見「目前能力邊界」）。
- `FACT_UNHANDLED ×N`：有 N 個 fact 沒有對應的 domain 規則，例如上例 `->first()` → `->firstOrFail()` 產生的 `CALL_REMOVED` / `CALL_ADDED`。這些變更仍已被 fact 解釋，所以檔案沒有其他無法解釋的變更時是 `TARGETED`。
- 每個 fact 都會讓檔案需要 review。PHP 檔只有在沒有任何 fact、AST 等價（排版、註解、一致的區域變數改名等，見「已實作」），而且不是 rename 或權限變更時，才會列在「不需要 review」，例如上例只加了註解、改了區域變數名稱的 `FreezeObserver.php`。
- 只有 `.php` 的修改與 rename 會送進 analyzer；新增、刪除、非 PHP、binary、symlink、submodule 檔案一律 `FULL`。rename 與檔案權限變更即使內容等價也要求 review（`FILE_RENAMED`、`FILE_MODE_CHANGED`）。
- PR 層級的決策只有在**所有**檔案都不需 review 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

選項（例如 `--json` 報表、讓 CI 在需要 review 時失敗的 `--fail-on-review`）、exit code、所有原因代碼、JSON 報表格式與限制見 [PR Review CLI](docs/review-cli.md)。

## 已實作

- Semantic Fact contract 與 fail-closed ingress
- `semanticFactsDigest`
- versioned Fact Interpreter identity 與 `interpreterSetDigest`
- JSON-safe deterministic Fact properties
- PHP CLI analyzer（執行需 PHP ≥ 8.3），以 [nikic/php-parser](https://github.com/nikic/PHP-Parser) 5.9.0（版本鎖定）解析 AST；被分析的程式碼先用最新 PHP 語法，失敗時 before / after 一起改用 PHP 7.4 語法
- AST 結構比對判定 completeness：排版、註解、trailing comma、引號種類、`array()` / `[]`、多餘括號不影響結果；每個被「解釋」的差異都必須對應一個 fact，因此沒有 fact 的 COMPLETE 只會發生在兩棵 AST 完全相同時（區域變數以 canonical 名稱比較，見下）
- Scope-aware 區域變數改名：method / function 內一致的區域變數改名視為等價（可安全減少 Review）。參數（named argument API）、`$this`、superglobal、magic local、`global` 變數、頂層變數與頂層 closure 的 `use` 變數不改名；scope 內出現 `compact`、`extract`、`get_defined_vars`、`$$x`、`eval`、`include` / `require`、單參數或 spread 參數的 `parse_str` / `mb_parse_str`、第一個參數不是明顯布林運算式的 `assert()`（PHP 7 會把字串參數當成程式碼在目前 scope 執行）時，整個 scope 不做改名正規化（含 `use function compact as x` 等別名）
- `__LINE__` 的行號與 `__COMPILER_HALT_OFFSET__` 納入 AST 比較：排版變更讓它們的值改變時不視為等價
- 判為等價前同時檢查 PHP 8 與 PHP 7 的解讀（7.4 語法，`#[` 視為註解）：兩邊的可解析性必須一致、且兩種語法下都等價，否則回報 `PHP_GRAMMAR_DIVERGENCE`（例如 `.` 與 `+` 的優先順序在 PHP 8 改變）。舊版 PHP 不支援的新語法（例如參數 trailing comma）不在檢查範圍，請以目標版本的 `php -l` 檢查
- Generic facts：
  - `CALL_ARGUMENT_CHANGED`（named argument；位置參數只在無法被更細 fact 解釋時以 `#index` 輸出，且不視為已解釋）
  - `CALL_REMOVED` / `CALL_ADDED`（含 closure 內的巢狀 call 與鏈式 call，如 `->lockForUpdate`；receiver 保留完整名稱，如 `$this->adminDB->transaction`）；同一位置換成另一個 method（`->first()` → `->firstOrFail()`）由這兩個 fact 一起解釋
  - `BINARY_OPERATOR_CHANGED`（左右運算元不變，只有運算子改變）
  - `GUARD_REMOVED` / `GUARD_ADDED`（body 只有 throw / return / exit 的 if）
  - `ARRAY_ITEM_REMOVED` / `ARRAY_ITEM_ADDED`（帶 container，如 `property:$beforeActionList`、`Route::group#0[middleware]`）
  - `LITERAL_CHANGED`（數字、字串、true / false / null 換成另一個字面值；帶 container，如 `const:RATE`、`$q->take#0`、`return[title]`）
  - `EXPRESSION_NEGATED`（`X` ↔ `!X`；container 標示位置，如 `if`、`while`、`ternary`、`return`）
  - `RETURN_VALUE_CHANGED`（回傳值換成常數或從常數換掉，如 `return null;`、`return [];`、`return;`；兩邊都不是常數時維持未解釋）
  - `CALL_ARGUMENTS_REORDERED`（參數內容相同、只有順序改變；method / function call 與 `new`）
  - `VARIABLE_CHANGED`（改用另一個變數，如部分改名、合併變數、參數改名；只在 scope 內一致改名也無法解釋差異時才輸出，container `param` 表示參數）
- Deterministic PHP/Laravel interpreters（callee 會先正規化 fully-qualified 前導 `\`；括號內的大寫代碼為輸出的 blocker；沒有任何 interpreter 處理的 fact 輸出 `FACT_UNHANDLED:<factId>`）：
  - Payment idempotency identity change（named argument `idempotencyKey` 改變 → `PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED`）
  - Transaction boundary removal（DB receiver 上的 `transaction` / `commit` 被移除，如 `DB::`、`\DB::`、`$db`、`$this->adminDB`、`$connection`；`beginTransaction` 不論 receiver → `TRANSACTION_BOUNDARY_REMOVED`）、rollback removal（DB receiver 上的 `rollBack` / `rollback` → `TRANSACTION_ROLLBACK_REMOVED`）
  - Authorization guard removal（`$this->authorize`、`$this->authorizeForUser`、`Gate::authorize`、`Illuminate\Support\Facades\Gate::authorize` → `AUTHORIZATION_GUARD_REMOVED`）；第一個參數的 ability 字串改值（如 `'update'` 改成 `'view'` → `AUTHORIZATION_ABILITY_CHANGED`）
  - Middleware guard removal（`$this->middleware(...)` / `->middleware(...)` 整個 call 被移除或少了 middleware、`Route::group` 的 `'middleware'` 被移除或少了 middleware、`$middleware` / `$middlewares` / `$beforeActionList` property 移除元素、middleware 名稱被換掉（如 `'auth'` 改成 `'guest'`）→ `MIDDLEWARE_GUARD_REMOVED`；只新增 middleware 時為 `FACT_UNHANDLED`）
  - Row lock removal（`lockForUpdate`、`sharedLock` → `ROW_LOCK_REMOVED`）
  - Payment signature verification removal（method 名稱含 `verif…sign`、`check…sign`、`validate…sign`、`sign…verif`、`sign…check` 或 `sign…valid`（不分大小寫），如 `verifySign`、`verificationSign`、`checkSign` → `SIGNATURE_VERIFICATION_REMOVED`）
  - Operator change（同類別內改變 → `COMPARISON_OPERATOR_CHANGED` / `ARITHMETIC_OPERATOR_CHANGED` / `LOGICAL_OPERATOR_CHANGED`；跨類別或其他運算子 → `OPERATOR_CHANGED`）
  - Guard clause removal / addition（`GUARD_CLAUSE_REMOVED` / `GUARD_CLAUSE_ADDED`）
  - Condition negation（`CONDITION_NEGATED`；條件以外的反轉為 `BOOLEAN_VALUE_NEGATED`）、回傳值改變（`RETURN_VALUE_CHANGED`）、參數順序（`ARGUMENTS_REORDERED`）、參數改名（`PARAMETER_RENAMED`，named argument API）、改用另一個變數（`VARIABLE_REFERENCE_CHANGED`）、class 常數改值（`CONSTANT_VALUE_CHANGED`）
  - Laravel validation rules（`rules()` 回傳值、`$this` / `$request` 的 `validate` / `validateWithBag`、`Validator::make` 的規則增減或改值 → `VALIDATION_RULE_CHANGED`）
  - Laravel model attributes（`$fillable` / `$guarded` → `MASS_ASSIGNMENT_CHANGED`、`$hidden` / `$visible` → `SERIALIZED_ATTRIBUTES_CHANGED`、`$casts` / `casts()` → `ATTRIBUTE_CAST_CHANGED`）
- persisted authority / stale analysis protection
- Summary / candidate digest binding
- Mutation Evaluation Harness
- Historical PR Evaluation Harness
- PR review CLI（`bin/review.js`，見 [PR Review CLI](docs/review-cli.md)）
- provider-neutral GitHub sink boundary

## 目前驗證基準

Mutation corpus：

```
Critical Recall               100.0%
False Negative Rate             0.0%
Critical Direct Fact Coverage 100.0%
Safe Reduction Rate           100.0%
Partial Coverage Rate          15.0%
Analysis Failure Rate           0.0%
Full Review Fallback Rate      15.0%
```

Real-repo evaluation（[說明](evaluation/real-repo/README.md)；兩個真實 PHP 金流專案與一個 Laravel 11 專案、3,093 個檔案，seed 42、rate 0.3，共 12,283 筆：3,093 unchanged、3,648 safe、5,542 risky）。`npm run eval:real-repo -- evaluate --repo <label>=<path> ...` 的摘要輸出：

```
Rows                         12283 (analyzed 12283, skipped 0, errors 0)
Risky reduced (must be 0)    0
Risky targeted rate          99.3%
Risky specific reason rate   53.4%
Safe reduction rate          100.0%
Unchanged reduction rate     99.9%
```

這三個專案不在本 repo 內（corpus 與結果含目標專案的原始碼片段，不能 commit），所以這些數字無法只靠本 repo 重現；它們是在本機以 commit `9022e04`（analyzer / interpreter 與 master `2be0cde` 相同）量測的一次性結果。Real-repo evaluation 不在 `npm run test:all` 與 CI 中，不屬於 release gate；修改 analyzer 或 interpreter 後，請對自己的專案以 `--baseline-ref` 重跑比較。

未被 reduce 的 3 個 unchanged 都是空檔（`parseable: false`）。Risky targeted rate 是 risky mutation 以 `TARGETED`（變更已被 fact 完整解釋）而非 `FULL` 送 Human Review 的比例，加入 `LITERAL_CHANGED` 等 facts 前為 34.6%。Risky specific reason rate 是原因中至少有一個 domain 規則產生的具體原因（不只有 `FACT_UNHANDLED`、`COV-…` 等 generic 原因）的比例，加入前為 9.3%。仍為 `FULL` 的主要是移除含 closure body 的 call（closure 內可能有任意邏輯）與改變運算子優先順序的 `&&` / `||` 互換。

Historical PR evaluator 的 CI pilot：

```
Human Concern Recall          100.0%
Review Scope Reduction         33.3%
Analysis Failure Rate           0.0%
Full Review Rate                0.0%
```

Historical 數字目前來自明確標示的 controlled fixture pilot，只驗證 evaluator wiring，**不代表真實世界 benchmark 已完成**。

## 文件

- [PR Review CLI：用法、merge base、選項、exit code、原因代碼與 JSON 報表](docs/review-cli.md)
- [目前能力與四階段實作整理](docs/current-state.md)
- [Safety MVP / Review Decision Engine 架構](docs/safety-mvp-architecture.md)
- [與 Agent Work Harness 的合作方式](docs/integrations/agent-work-harness.md)
- [Real-repo Evaluation：在真實 PHP 專案上產生 mutation 並驗證 gate](evaluation/real-repo/README.md)

### 歷史任務紀錄

以下是各 PR 合入當時的設計紀錄，之後可能已變更；目前能力以本文件的「已實作」與「目前驗證基準」為準。

- [PR-A：Semantic Fact Ingress](docs/tasks/2026-10-06-semantic-fact-ingress.md)
- [PR-B：PHP/Laravel Adapter](docs/tasks/2026-10-06-php-laravel-adapter.md)（`token_get_all` 初版；analyzer 已改用 nikic/php-parser AST，需 Composer 依賴）
- [PR-C：Mutation Evaluation](docs/tasks/2026-10-06-mutation-evaluation.md)（初始 corpus 與 baseline；SAFE-002 現已可被 reduce，MUT-004 現已有直接 fact `BINARY_OPERATOR_CHANGED`）
- [PR-D：Historical PR Evaluation](docs/tasks/2026-10-06-historical-pr-evaluation.md)

## Release gate

執行 analyzer 需要 PATH 上的 `php`（PHP CLI ≥ 8.3，`analyzers/php/composer.json` 的要求；CI 使用 8.4）與 Composer 2。PHP analyzer 依賴 Composer 套件，第一次執行前先安裝：

```bash
npm run analyzer:install
```

缺少依賴時 analyzer 會以 `PHP_ANALYZER_DEPENDENCY_MISSING` fail-closed。PHP 版本不足時 `composer install` 會因 platform requirement 失敗；已安裝的依賴也會在執行時被 Composer 的 platform check 擋下，此時（以及找不到 `php` 時）`bin/review.js` 不會以錯誤結束（exit code 仍為 0，`--fail-on-review` 時為 1），而是把每個送進 analyzer 的 PHP 檔以 `ANALYZER_ERROR` 列為 `FULL`（見 [PR Review CLI](docs/review-cli.md#前置需求)）。

```bash
npm run test:all
```

包含：

- lint（ESLint，只檢查 JS）
- safety tests
- E2E
- coverage
- mutation evaluation
- historical evaluation

CI（`.github/workflows/review-reduction-safety.yml`，Node.js 24、PHP 8.4）在 `npm ci` 之後先執行 `composer install --working-dir=analyzers/php`，再對 `analyzers/php/bin`、`analyzers/php/src` 與 `evaluation` 下的每個 `.php` 檔執行 `php -l`，最後執行 `npm run test:all`。`php -l` 不在 `test:all` 內，修改 PHP 檔時本機可用同一行指令檢查：

```bash
find analyzers/php/bin analyzers/php/src evaluation -name '*.php' -print0 | xargs -0 -n1 php -l
```

## 與 Agent Work Harness 的關係

兩者不互相取代：

```
Agent Work Harness
「這次 agent 工作是否可信地完成？」

Reviewer
「這些完成的變更中，哪些仍需要人工 Review？」
```

建議整合方式：

```
Codex / Claude Code
        ↓
Agent Work Harness
        ↓
Verification SUCCESS
        ↓
Reviewer
        ↓
Review Scope Plan
        ↓
Human / AI Reviewer
```

詳細設計見 [docs/integrations/agent-work-harness.md](docs/integrations/agent-work-harness.md)。

## 目前能力邊界

目前 reduction 應視為 **file-level review scope reduction** 的基礎。

雖然 semantic facts 已有 byte provenance，但 blocker 尚未正式建立：

```
blocker → factId → provenance
```

的完整 region-level selection contract，因此目前不應宣稱能安全縮減到「某檔只有哪幾行需要看」。`TARGETED` 列出的位置只是 review 的起點，整個檔案仍需 review。

判定 AST 等價時刻意接受、不視為行為差異的情況：排版變更讓例外訊息、backtrace 與匿名 class 名稱中的行號改變；一致改名的 closure `use` 變數與 `static` 變數名稱（可透過 reflection 讀到）；舊版 PHP 不支援的新語法（請以目標 PHP 版本的 `php -l` 檢查）；PHP 5 的語意（只檢查 PHP 7 與 PHP 8 的解讀）。詳見 [Real-repo Evaluation](evaluation/real-repo/README.md)。

後續優先方向：

1. 真實 Historical PR corpus。
2. 增加 PHP/Laravel 支援範圍，降低 `PARTIAL_PARSE`。
3. 提高 risky 變更的具體原因比例（real-repo 的 Risky specific reason rate 目前 53.4%，其餘只有 `FACT_UNHANDLED` 等 generic 原因），並減少仍為 `FULL` 的情況（移除含 closure body 的 call、改變運算子優先順序的 `&&` / `||` 互換）。Safe Reduction Rate 在 mutation corpus 與 real-repo 都已是 100.0%，但 safe 案例只涵蓋排版、註解、引號、trailing comma、區域變數改名等變更；真實 PR 的 reduction 需以第 1 點的 corpus 衡量。
4. 建立 multi-file Review Plan（`bin/review.js` 已提供 PR 層級的逐檔決策與位置提示）。
5. 再往 region-level review scope 發展。
