# Safety MVP 測試策略

## 目的

這份文件是 Safety MVP 後續測試的強制規範。測試不只確認正常結果，還必須證明任何證據缺失、資料矛盾、結果過期或發布失敗，都不能產生 reduction success。

目前測試使用 Node.js native ESM、`node:test`、table-driven cases 與 deterministic exhaustive cases；不依賴 LLM、網路或無法重現的隨機資料。N-01 的 AdapterResult ingress、context binding contract tests，以及可執行的 PHP/Laravel Adapter 都在範圍內。

只有下表四個測試檔會執行外部程式；其他測試（contracts、coverage、reducer、evidence / impact / invariant、semantic facts、domain interpreters、publication、storage、sink、E2E 與 evaluation metrics）都不執行外部程式。

| 測試 | 執行的外部程式 |
|---|---|
| `tests/adapters/php-laravel.test.js` | `php analyzers/php/bin/analyze.php`（真實 analyzer，nikic/php-parser 5.9.0） |
| `tests/adapters/php-laravel-failures.test.js` | 以 Node 撰寫的 fake analyzer 模擬 process 失敗；缺少依賴的案例執行真實的 `analyze.php` |
| `tests/review/review.test.js` | `git`（在暫存目錄建立 repository）、真實 analyzer 與 `bin/review.js` |
| `tests/evaluation/real-repo-cli.test.js` | `php evaluation/real-repo/generate.php`、真實 analyzer、`git` 與 `tar`（從本 repo 的 `HEAD` 建立 baseline snapshot） |

`npm run eval:mutations` 與 `npm run eval:historical` 也以真實 analyzer 執行完整 pipeline。因此執行測試前需要：

- PHP CLI 8.3 以上，以 `php` 的名稱放在 PATH 上（`analyzers/php/composer.json` 的要求；CI 使用 PHP 8.4），以及 Composer 2。
- 已執行 `npm run analyzer:install`（`analyzers/php/vendor/` 不納入版本控制）。缺少依賴時 analyzer 以 `PHP_ANALYZER_DEPENDENCY_MISSING` fail-closed（obligation `FAILED`），real-repo 的 `loadReviewer()` 以 `ANALYZER_DEPENDENCY_MISSING` 立即失敗；上述測試與 `eval:mutations` 都會失敗，不會被當成通過。`eval:historical` 的 gate 只檢查 publication 是否被接受，以及 human concern 是否落在被選取的檔案；此時每個檔案都是 Full Review，所以仍會通過，但 Analysis Failure Rate 為 100%。
- PATH 上的 `git` 與 `tar`，並在本 repo 的 git checkout 中執行（real-repo baseline 測試會讀取本 repo 的 `HEAD`）。

real-repo generator 以 seed 與檔案路徑重設 `mt_srand`，相同 seed 產生相同 corpus，測試會驗證這一點。

## 測試分層

| 層級 | 目標 | 必須使用的入口 |
|---|---|---|
| Contract / Unit | 驗證單一模組的輸入、輸出與 reason code | 對應 production function |
| Property / Invariant | 驗證安全不變量不會被組合輸入破壞 | deterministic 生成或 exhaustive table |
| Executable Adapter | 驗證真實 PHP analyzer 的 AST 比對、facts 與 failure code | `createPhpLaravelAdapter().analyze()` + `fixtures/php-laravel` 或 inline PHP source；process 失敗用 fake analyzer |
| Vertical | 驗證一個完整業務分支 | `runSafetyMvp()` |
| End-to-end pipeline | 驗證 analysis、publication、Summary、status check 的跨模組綁定 | `runSafetyMvp()` + fixture；adapter 到 sink 的 E2E 使用 `runStoredAdapterPipeline()` + `fixtures/e2e` |
| PR review CLI | 驗證 git 範圍（merge base → head）到逐檔決策、PR 彙整、輸出與 exit code | `reviewRange()` + 暫存 git repository、`bin/review.js` |
| Evaluation | 驗證 evaluation 的 metrics 與 gate，並以 corpus 量測 recall 與 reduction | metrics function、`evaluation/real-repo/cli.js`、`npm run eval:mutations` / `eval:historical` |

測試命名必須說明「條件 → 預期安全結果」，使用正體中文；契約常數如 `PARTIAL_PARSE`、`FAILURE`、`STALE_ANALYSIS_IDENTITY` 保留原文。

## 每個案例的四面檢查

每個 production behavior 至少要有：

1. 正向案例：合法且完整的輸入能得到預期結果。
2. 反向案例：缺失、錯誤或矛盾輸入會 fail-closed。
3. 邊界案例：空值、最小值、最大值、零長度、邊界轉換與多筆組合。
4. 整合案例：結果經過下一個 authority boundary 後，安全語意仍然成立。

若一個案例同時測多個獨立錯誤，應拆成 table-driven cases；只有在需要驗證多錯誤聚合時，才保留多錯誤輸入。

## Safety invariants

所有後續測試都必須維護以下不變量：

- Required coverage 只要有一筆不是 `COMPLETE`，就不能產生 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- 空 coverage、空 changed region、缺 path/language/adapter/runtime 都不能被視為安全證據。唯一的明文例外在 PR review CLI 的 PR 彙整層級：merge base 到 head 沒有任何檔案變更時，PR 決策是 `NOT_SELECTED_FOR_HUMAN_REVIEW`，原因 `NO_CHANGES`。這表示沒有變更需要 review，不是 analyzer 的 coverage 證據；只要有任何檔案變更，PR 就只在每個檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- `unknown` 或非法 runtime 必須保留 blocker。
- Normalized core input 的負值、零長度、逆序、重疊或未排序 byte range 必須 fail-closed；raw `AdapterResult` 可以未排序，但不可重疊，並由 N-02 normalization 排序後才進入 core。
- `ELIGIBLE` 不得含 blocker；`NOT_ELIGIBLE` 與 `ANALYSIS_FAILED` 必須有 blocker。
- 增加 blocker、移除 evidence 或降低 coverage，不得把 Human Review 變成 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- Candidate、Summary、Status Check 必須共用完整 `AnalysisIdentity`、相同 candidate digest，以及存在時的 `AnalysisContextBinding`。
- 舊 head、舊 policy、舊 runner 或晚完成舊 run 不得覆蓋 current authority。
- Analysis failure、Summary 缺失或 Summary 發布失敗不能回傳 status success。
- `PASS` 只代表 authoritative Summary 綁定正確，不代表不需要 Human Review；Review decision 必須另外檢查。
- Reduction 是 file-level。`TARGETED` 與 `FULL` 都是 `HUMAN_REVIEW_REQUIRED`，都要求 review 整個檔案；兩者的差別是 Reviewer 是否已經知道每個變更是什麼，不是要看的範圍大小。
  - PHP 檔案的 `TARGETED` 表示檔案中的每個變更都已被具體的 fact 解釋（包括沒有 domain 規則、只產生 `FACT_UNHANDLED` 的 fact），或內容等價、只有 rename / 權限改變（`FILE_RENAMED` / `FILE_MODE_CHANGED`，可能沒有任何 fact）。至少有一個變更無法解釋，或檔案沒有（或無法）分析時是 `FULL`。
  - reducer 只在 blocker 都不以 `COV-`、`COVERAGE_`、`ANALYZER_` 開頭時給 `TARGETED`；policy requirement 與 `AUDIT_SAMPLE` 也是 `TARGETED`。任何 coverage / analyzer blocker 都必須維持 `FULL`。
  - `TARGETED` 標示的位置只是 review 起點。測試與輸出不得把 `TARGETED` 斷言或呈現為「只有這些行需要 review」。

## 模組最低測試矩陣

### Contracts

- identity 六個欄位各自缺失與各自 mismatch。
- coverage 缺失、空 required set、缺 ID、重複 ID、未知 status。
- risk blockers、policy requirements、audit、analysis error 的型別錯誤。
- eligibility 狀態未知、blocker 缺失、`ELIGIBLE` 含 blocker。
- candidate status、coverage、eligibility、decision 的矛盾組合。

### Adapter Contract / Context Binding

- 合法的多 Adapter `AdapterSet`、capability allowlist，以及 adapter 順序的 canonical digest。
- 缺少、重複、錯誤型別或未知 capability；`diagnostics`、`evidenceReferences`、`complete` 與 `reasonCode` 的契約完整性。
- runtime namespace/id/source/version、未知 runtime blocker、language ownership，以及未宣告 adapter 的拒絕行為。
- range 邊界、raw 未排序但不重疊的接受行為，以及 raw 重疊的拒絕行為。
- `adapterSetDigest`、`executionContextDigest` 的 deterministic serialization、adapter/language 順序與 runtime tampering。
- authority context 缺漏、格式錯誤、legacy mismatch、binding mismatch、head transition 與失敗時不得改變 authoritative state。

### Normalization / Reference Adapter

- mixed-language regions 必須保留 path、byte range、language、adapter 與 runtime ownership，並按 path/range deterministic 排序。
- 同一 path 的零長度、逆序或重疊 region 必須拒絕；不同 path 的相同 byte range 不得互相誤判。
- `COMPLETE`、`PARTIAL_PARSE`、`UNSUPPORTED`、`TIMEOUT`、`TRUNCATED`、`FAILED` 的 mapping 必須可重現。
- reference adapter 只能 deep-clone fixture；aborted signal 必須回傳合法的 Adapter-declared `TIMEOUT` result。
- normalized runner 必須按 validation → normalization → `runSafetyMvp()` 順序執行，malformed result 必須進入 analysis failure。

### Adapter Execution Boundary

- valid adapter resolve 必須只回傳 AdapterResult outcome，不得由 Adapter 直接產生 reduction decision。
- Adapter-declared obligation `TIMEOUT` 必須經 N-02 normalization 變成 `INCOMPLETE` / Human Review。
- execution deadline、pre-aborted signal、AbortSignal、exception 與 malformed output 必須分別產生 stable failure code，進入 `ANALYSIS_FAILED` / Full / check `FAILURE`。
- timeout 後的 late resolution、throw 或 result 都不得觸發 publication，也不得覆寫既有 authoritative candidate。
- failure outcome 不得包含 exception object 或 stack trace；failure code 必須是 candidate 可重算且 deterministic 的輸入。

### PHP/Laravel Adapter（`analyzers/php`、`src/adapters/php-laravel`）

測試：`tests/adapters/php-laravel.test.js`（真實 analyzer）、`tests/adapters/php-laravel-failures.test.js`（failure path）。facts 的定義見 [README「已實作」](../../README.md#已實作)。

- AST 等價：排版、註解、trailing comma、引號種類、`array()` / `[]`、多餘括號判為 `COMPLETE` 且無 fact。沒有 fact 的 `COMPLETE` 只能發生在兩棵 AST 完全相同時（soundness 案例）；任何沒有被 fact 解釋的差異都必須是 `PARTIAL_PARSE` + `UNRECOGNIZED_PHP_CHANGE`。
- 語法版本：最新語法無法解析任一側時，兩側一起改用 PHP 7.4 語法（例如 `$str{0}`）；兩種語法都無法同時解析兩側時回傳 `PHP_PARSE_ERROR`（`FAILED`）。原本會判為無 fact 的 `COMPLETE` 時，若在最新語法或 PHP 7 視角（7.4 語法，`#[` 視為註解）下兩側的可解析性不一致，或兩側都能解析但不等價，必須改為 `PARTIAL_PARSE` + `PHP_GRAMMAR_DIVERGENCE`。
- 排版讓 `__LINE__` 或 `__COMPILER_HALT_OFFSET__` 的值改變時，不得判為無 fact 的 `COMPLETE`。
- Scope-aware 改名：scope 內一致的區域變數改名判為 `COMPLETE` 且無 fact。不改名的變數（參數、`$this`、superglobal、magic local、`global` 變數、頂層變數、頂層 closure 的 `use` 變數）與整個 scope 不改名的情況（`compact`、`extract`、`get_defined_vars`、`$$x`、`eval`、`include` / `require`、單參數或 spread 參數的 `parse_str`、PHP 7 字串 `assert()`，含 `use function` 別名）都要有案例。canonical 名稱不得與保留原名的變數碰撞（例如參數 `$__rv0`）；改名同時有其他變更時仍輸出對應 fact；無法以改名解釋的變數差異輸出 `VARIABLE_CHANGED`；不安全的改名絕不判為無 fact 的 `COMPLETE`。目前 `$this`、superglobal、`get_defined_vars`、`eval`、`require` 與單參數 `parse_str` 沒有專用案例。
- 每種 generic fact 都要有真實 analyzer 的正向案例，以及「不得誤判為完整」的反向案例，例如：位置參數的 `#index` fallback 維持 `PARTIAL_PARSE`、非 guard 的 if 被移除時維持 `PARTIAL_PARSE`、回傳值換成另一個非常數運算式時維持 `PARTIAL_PARSE`。Adapter 只輸出 generic fact，不在 Adapter 內解讀 domain 風險（例如移除 `authorize` call 只輸出 `CALL_REMOVED`）。目前 `GUARD_ADDED` 與 `ARRAY_ITEM_ADDED` 只有 interpreter 與 `describeFact` 層的測試，缺少真實 analyzer 的案例。
- 回傳 terminal result 的失敗：`PHP_ANALYZER_INPUT_INVALID`（不得執行 analyzer）、analyzer 回傳 `ok:false` 時沿用其 code（缺 code 時為 `PHP_ANALYZER_FAILED`）、`PHP_ANALYZER_DEPENDENCY_MISSING`，obligation 都是 `FAILED`；head 為空檔時 `PHP_FILE_DELETION_UNSUPPORTED`（`UNSUPPORTED`）。這些結果都不能視為安全。
- reject 的失敗：非零 exit（`PHP_ANALYZER_EXIT_<code>:<stderr>`）、stdout 不是 JSON（`PHP_ANALYZER_OUTPUT_INVALID`）、abort signal 終止 analyzer（`PHP_ANALYZER_ABORTED`）與 spawn error（例如 `ENOENT`）都必須讓 `analyze()` reject；runner 再經 Adapter Execution Boundary 轉成 failure（Full），review CLI 轉成 `ANALYZER_ERROR:*`（`FULL`）。
- analyzer 缺 facts、diagnostics 或 reasonCode 時以 fail-closed 預設值補齊（`UNRECOGNIZED_PHP_CHANGE`）；changed region 的 `endByte` 以 UTF-8 byte 計算；analyzer 未讀完 stdin 就結束時，大型 payload 造成的 EPIPE 不得讓 process crash。
- 整合：真實 fact 沒有 interpreter 處理時經 reducer 保留 Human Review（`FACT_UNHANDLED`）；domain interpreters 不得吞掉不認識的 generic fact。

### Semantic Facts / Fact Interpreter Boundary

測試：`tests/facts/semantic-facts.test.js`。

- 合法 fact 保留 provenance 與 source，並 deterministic normalization；`semantic-facts` capability 已宣告但 facts 缺失、重複 fact id、malformed provenance、properties 非 JSON-safe 都必須讓 AdapterResult 無效。
- fact 內容或 interpreter version 改變時，`semanticFactsDigest` / `interpreterSetDigest` 與 `AnalysisContextBinding` 都必須改變。
- interpreter 必須是有 `id` / `version` / `interpret` 的 descriptor；裸 function 不是合法 interpreter，`createAnalysisContextBinding()` 必須拒絕，`interpretSemanticFacts()` 必須產生 `ANALYZER_FACT_INTERPRETER_SET_INVALID`。
- 沒有受信任 interpreter 處理的 fact 必須產生 `FACT_UNHANDLED:<fact id>` 並保留 Human Review；只有被明確處理且沒有 blocker 的 fact 才可沿用既有 reduction；增加 unresolved fact 只能增加 blocker。
- interpreter 丟出 exception 時產生 `ANALYZER_FACT_INTERPRETER_FAILED:<interpreter>:<fact>` 並採 Full Review。interpreter 回傳非法 result（`ANALYZER_FACT_INTERPRETER_INVALID_RESULT:*`）與 facts 不是陣列（`ANALYZER_SEMANTIC_FACTS_INVALID`）目前沒有專用測試。

### PHP/Laravel Domain Interpreters（`src/interpreters/php-laravel-domain.js`）

測試：`tests/interpreters/php-laravel-domain.test.js`（直接呼叫 interpreter），以及 `tests/adapters/php-laravel.test.js` 中經真實 analyzer 的整合案例。各 interpreter 產生的原因代碼見 [PR Review CLI「Domain 原因代碼」](../review-cli.md#domain-原因代碼)。

- `PHP_LARAVEL_DOMAIN_INTERPRETERS`（15 個）通過 `validateFactInterpreters()`，且 id 唯一。
- `calleeParts()` 先移除 fully-qualified 前導 `\`，再拆出 receiver / method（含 `?->` 與鏈式 `->x`）；空字串或非字串回傳 `null`。
- 每個 interpreter 的每個 blocker 都要有正向案例，並要有「非目標的 fact kind、receiver、container 或 subject 回傳 `handled: false`」的反向案例。反向案例至少包括：非 DB receiver 與 `CALL_ADDED` 不是 transaction 移除；`$model->authorize` 不是授權 guard；只新增 middleware、只改 `prefix` 或 `Route::group` 的 closure 參數不是 middleware 移除；`sign`、`signIn`、`design` 不是驗簽；位置參數不是 idempotency key；非 `rules()` method、非 return 位置與沒有 receiver 的 `->validate` 不是 validation rule；`$appends` 等其他 property 不是 model attribute。
- 所有 interpreter 都回傳 `handled: false` 的 fact 必須落到 `FACT_UNHANDLED`，不得被當成已處理。

### Coverage

- 合法單一與多筆 obligation。
- `PARTIAL_PARSE`、`UNSUPPORTED`、`TIMEOUT`、`TRUNCATED`、`FAILED`。
- 缺少 changed regions、空 changed regions、缺 path/language/adapter。
- 非法 runtime、`unknown` runtime。
- 負值、零長度、逆序、重疊、未排序與相鄰 byte ranges。
- 多個 required obligations 中任一筆失敗。

### Reducer

- `ELIGIBLE`、risk `NOT_ELIGIBLE`、coverage `NOT_ELIGIBLE`、`ANALYSIS_FAILED`。
- policy requirement 與 audit selection。
- blocker 去重、排序與完整保留。
- blocker 增加的 monotonic property test。
- eligibility 缺失與內部矛盾的 fail-closed 結果。

### Evidence / Impact / Invariant

- evidence stable id、source、subject、kind、complete 與 provenance 的合法、缺失、重複、錯型別與零長度 range。
- impact edge 去重、missing node、missing provenance 與 required subject unresolved。
- invariant required set、mapping missing、subject scope 與 provenance mismatch。
- 增加任一 unresolved fact 的 monotonic property：只能增加 blocker，不能改成 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

### Persistent Authority / CAS

- memory store 的 initialize、CAS success、stale no-op、head transition、same-digest idempotency 與 same-head conflict。
- SQLite close/reopen 讀回 current authority，以及 restart 後 old run no-op。
- candidate context binding mismatch 不得寫入 persisted authority。

### Provider-neutral Sink

- Summary/check success、non-2xx、timeout/exception、malformed response、retry request identity 與 same-head conflict。
- sink failure 不得改寫 authority、candidate 或安全 check；stale candidate 不得呼叫 sink。
- GitHub payload contract（`validateGithubPayload()`，`tests/integrations/github-contracts.test.js`）：必要欄位缺失或空白、Summary 缺失、缺 binding 或不符合 candidate contract、identity 或 digest mismatch、check state 只接受 `PASS` / `FAILURE`、check reason 缺失；`ANALYSIS_FAILED` 不得以 `PASS` 發布。

### Publication / Summary

- identity 六欄位逐一 mismatch。
- incomplete、invalid、矛盾 candidate 不得修改 authority。
- 新結果先發布後，舊結果晚完成不得覆蓋。
- Summary 缺失、發布失敗、identity 不同、digest 不同、內容竄改。
- Candidate 與 Summary 的 decision、coverage、eligibility 任一欄位變更都必須被偵測。
- Summary 與 Status Check 在 adapter ingress 存在時必須綁定同一 context binding；valid、malformed、缺一側、stale mismatch 與 head transition 都要覆蓋。

### Pipeline / Fixtures

- Human Review targeted。
- Human Review full。
- NOT_SELECTED。
- analysis failure。
- partial / unsupported / timeout / truncated coverage。
- stale head 與 stale Summary。
- `AdapterResult → AnalysisContextBinding → runner → authority → Summary/Status Check` 的 binding 必須一路保留且可驗證。

### PR Review CLI（`bin/review.js`、`src/review/*`）

測試：`tests/review/review.test.js`。CLI 的行為定義見 [PR Review CLI](../review-cli.md)。`bin/review.js` 不在 c8 coverage gate 內（只計算 `src/**/*.js`），只由執行 CLI 的案例保護。

- git 解析：`parseRawDiff` 解析修改、新增、刪除、rename（含相似度）、權限與 type change，格式錯誤時為 `GIT_DIFF_UNPARSABLE`；`parseHunks` / `changedLines` 把 hunk 轉成 head / base 行號；`lineLocator` 以 UTF-8 byte offset 計算行號；`resolveCommit` 拒絕空字串與像選項的 ref（`GIT_REF_INVALID`）以及不存在的 ref（`GIT_FAILED`）。
- 比較範圍：從 merge base 算起。base 在分支建立後的新 commit 不列入；報表的 `base.sha` 是 base ref 的 commit，`mergeBase` 是比較起點；merge base 與 base 不同時文字輸出標示比較起點，相同時不標示；沒有共同祖先時為 `GIT_NO_MERGE_BASE`。
- 檔案分類：[「檔案分類」](../review-cli.md#檔案分類)表的每一列都要有案例；第 1–7 步不得呼叫 analyzer，一律 `FULL`。analyzer 失敗（例如 PHP binary 不存在）時該檔案 fail-closed 為 `FULL`（`ANALYZER_ERROR:*`），PR 不得因此變成 `NOT_SELECTED_FOR_HUMAN_REVIEW`。目前 `SUBMODULE_CHANGED` 與 `UNSUPPORTED_CHANGE_TYPE:type-changed` 沒有 `reviewRange()` 層級的案例（type change 只有 `parseRawDiff` 的解析案例），`--timeout-ms` 逾時造成的 `ANALYZER_ERROR:PHP_ANALYZER_ABORTED` 只在 adapter 層測試。
- rename 與權限變更：內容等價時必須是 `TARGETED`，原因只有 `FILE_RENAMED` / `FILE_MODE_CHANGED`；內容也有變更時接在 analyzer 的原因之後。目前只有內容等價的案例。
- 逐檔決策：`NOT_SELECTED_FOR_HUMAN_REVIEW`、`TARGETED`、`FULL` 都要有案例。需要 review 的檔案附 `changedLines`（git hunk 的 head / base 行號），`NOT_SELECTED_FOR_HUMAN_REVIEW` 不附；`TARGETED` 另有每個 fact 的 side 與行號。這些位置只是 review 起點（見「Safety invariants」）。
- PR 彙整（`summarizeFiles`）：只有所有檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時 PR 才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`；`reasons` 是需要 review 的檔案原因去重後排序的結果；只有排版變更時 `reasons` 為 `[]`；沒有任何檔案變更（例如 base 與 head 是同一個 commit）時為 `NO_CHANGES`。
- 輸出與 exit code：文字輸出（`formatReview`，含 `FACT_UNHANDLED ×N` 的合併）、`describeFact` 對每種 fact 的描述、`--json`、`--out`（內容與 stdout 的 JSON 相同）、`--help`；exit code 0、1（`--fail-on-review` 且需要 review）與 2（例如 `OPTION_MISSING`、`OPTION_INVALID`）。exit code 的完整定義見 [「Exit code 與錯誤」](../review-cli.md#exit-code-與錯誤)。

### Evaluation harness（`evaluation/`）

`evaluation/**` 不在 c8 coverage gate 內（只計算 `src/**/*.js`），以下行為只由這些測試保護。

- Mutation evaluation（`evaluation/mutations`，測試 `tests/evaluation/mutation-metrics.test.js`）：critical recall 與 direct fact coverage 分開計算；critical mutation 被 `NOT_SELECTED_FOR_HUMAN_REVIEW`（`CRITICAL_FALSE_NEGATIVE`、`DECISION_REGRESSION`）或預期 fact 消失（`EXPECTED_FACT_MISSING`）時 gate 必須失敗。`PIPELINE_PUBLICATION_FAILED` 與 `EXPECTED_REASON_MISSING` 目前只在 `npm run eval:mutations` 對 corpus 執行時檢查，沒有獨立的 metrics 測試。
- `npm run eval:mutations` 以 `evaluation/mutations/cases.json` 的案例（fixture 在 `fixtures/php-laravel`）跑完整 pipeline，任何 gate failure 時 exit code 為 1。新增案例必須寫 `classification`（`critical` / `safe`）與 `expectedCurrentDecision`；預期的 fact 與 domain 原因寫在 `expectedFactKinds` / `expectedReasons`，gate 會檢查它們沒有消失。
- Historical evaluation（`evaluation/historical`，測試 `tests/evaluation/historical-metrics.test.js`）：concern recall 與 review scope reduction 分開量測；human concern 落在未選取檔案時 gate 必須失敗（`HISTORICAL_CONCERN_MISSED`）；aggregate 以總 concern / file 數計算；manifest 的 concern path 必須屬於 changed files。
- Real-repo toolkit（`evaluation/real-repo`，測試 `tests/evaluation/real-repo-metrics.test.js`、`real-repo-cli.test.js`，以 `fixtures/php-laravel` 與暫存目錄當作目標 repo）：
  - corpus：`--repo` 解析、JSONL 解析、row 驗證、`applyEdits` 以 byte offset 套用（含 UTF-8 多位元組字元），拒絕重疊或超出範圍的 edit。
  - generator：相同 seed 產生相同 corpus；每個檔案的 mutation 不受其他檔案增減影響；safe / risky 標籤經 AST 驗證；`__LINE__` 之前的換行只會是 risky；`use function` 別名的 `compact` 視為 name-sensitive；git repo 中沒有被追蹤的 PHP 檔時失敗。
  - gate（`validateResults`）：`RISKY_REDUCED`、`ANALYZER_ERROR`、`UNCHANGED_NOT_REDUCED`（`parseable: false` 除外）、`NO_ROWS_ANALYZED`、`REPO_NOT_ANALYZED`；`SOURCE_CHANGED` / `SOURCE_MISSING` 只列為 warning，該筆不分析。gate 的定義見 [Real-repo Evaluation「標籤與 gate」](../../evaluation/real-repo/README.md#標籤與-gate)。
  - 執行：缺少 repo root 或 corpus 格式錯誤時 `runCorpus` 拒絕執行；analyzer 超過 timeout 時被終止並記為 `ERROR`；reviewer checkout 缺少 PHP 依賴時以 `ANALYZER_DEPENDENCY_MISSING` 立即失敗；`--baseline-ref` 從 git ref 建立可執行的 snapshot，收到 SIGTERM 時移除 snapshot。
  - 報表與 CLI：`summarizeResults`、`formatSummary`、`compareResults`（拒絕不同 corpus 的結果）；exit code 0 通過、1 gate failure、2 參數或執行錯誤。
- 對真實專案執行的 real-repo evaluation 不在 `npm run test:all` 與 CI 內，見「測試品質門檻」。

## Fixture 規範

Safety MVP pipeline fixture（`fixtures/safety-mvp`）必須包含：

```json
{
  "identity": {},
  "adapterResult": {
    "adapterSet": [],
    "obligations": [],
    "diagnostics": [],
    "evidenceReferences": [],
    "complete": true
  },
  "coverage": { "obligations": [] },
  "riskBlockers": [],
  "policyRequirements": [],
  "expected": {
    "analysisStatus": "COMPLETE",
    "decisionStatus": "HUMAN_REVIEW_REQUIRED",
    "fallback": "TARGETED",
    "reasons": [],
    "headSha": "head-001",
    "checkState": "PASS",
    "checkReason": "CURRENT_AUTHORITATIVE_SUMMARY"
  }
}
```

N-01 fixture 必須提供 `AdapterResult`；stale-run fixture 也要把它放在被分析的 input context 內。測試會由該結果計算 binding，並將同一份 binding 傳給 runner 與 authority，驗證 context 被竄改或遺漏時 fail-closed。

Stale fixture 可以另外使用 `input` 與 `currentIdentity`，但必須明確寫出 publication reason 與 check reason。

PHP fixture（`fixtures/php-laravel/<name>/`）以 `before.php` / `after.php` 一對檔案表示一個變更，供 PHP Adapter 測試、mutation evaluation 與 real-repo toolkit 測試使用。

## 測試品質門檻

每次修改 production code 或新增 fixture 後，必須執行與 CI 及 [README「Release gate」](../../README.md#release-gate)相同的檢查：

```bash
npm run analyzer:install   # 第一次，或 analyzers/php/composer.lock 變更後
find analyzers/php/bin analyzers/php/src evaluation -name '*.php' -print0 | xargs -0 -n1 php -l
npm run test:all
```

- `npm run analyzer:install` 以 Composer 安裝 analyzer 依賴；沒有安裝時 PHP 相關測試會失敗（見「目的」）。CI 在 `npm ci` 之後執行 `composer install --working-dir=analyzers/php`。
- `php -l` 不在 `test:all` 內；ESLint 與 c8 都不涵蓋 PHP，CI 在 `test:all` 前執行同一行指令。
- `npm run test:all` 依序執行 `lint`、`test:safety`、`test:e2e`、`test:coverage`、`eval:mutations`、`eval:historical`，任一步失敗即停止：
  - `lint`：ESLint，只檢查 `bin`、`src`、`tests`、`evaluation` 中的 JS。
  - `test:safety`：`node --test`，執行 `tests/` 下所有測試，包括 E2E、PHP Adapter、PR review CLI 與 evaluation 測試。
  - `test:coverage`：c8 只計算 `src/**/*.js`，門檻為 lines / functions / statements 90%、branches 85%。
  - `eval:mutations` / `eval:historical`：以真實 analyzer 執行 corpus，gate failure 時失敗。

pre-commit hook 只執行 `npm run lint`。Pull request 不得只執行 lint 或單一 test file。若新增 production branch，必須同一變更補上至少一個正向、反向、邊界或整合案例，並在本文件矩陣中留下對應項目。

修改 `analyzers/php` 或 `src/interpreters/php-laravel-domain.js` 時，應另外對真實 PHP 專案執行 real-repo evaluation，並以 `--baseline-ref` 與修改前的版本比較；`RISKY_REDUCED` 必須為 0：

```bash
npm run eval:real-repo -- evaluate --repo <label>=/path/to/php-repo --baseline-ref <base ref>
```

目標專案不在本 repo 內，這項檢查不在 `npm run test:all` 與 CI 中。操作方式與 gate 定義見 [Real-repo Evaluation](../../evaluation/real-repo/README.md)，最近一次的量測結果見 [README「目前驗證基準」](../../README.md#目前驗證基準)。

## 不在本策略內的項目

以下需要獨立的 integration test suite，或屬於手動量測，不由 deterministic Safety MVP tests 假裝涵蓋：

- PHP 以外語言的真實 parser 與可執行 Language Adapter，以及 Laravel 以外的 Framework Adapter（N-01/N-02 contract、normalization、reference adapter 與 PHP/Laravel Adapter tests 在範圍內）。
- 真實 GitHub API credential、跨 process locking 與 production transport；N-05 SQLite transaction、N-06 fake transport 與 N-07 E2E 在本策略範圍內。
- 外部 process 的 OS 層級資源限制與網路失敗。analyzer 的 abort / timeout 終止、spawn 失敗、非零 exit、輸出不是 JSON、缺少依賴與 EPIPE 在範圍內；adapter 終止 analyzer 時只送 `SIGTERM`，analyzer 忽略 `SIGTERM` 的情況沒有 `SIGKILL` 升級，也沒有測試。
- 大型 repository 的效能、資源限制與負載測試。對真實專案執行的 real-repo evaluation 是手動量測，不是效能測試；real-repo toolkit 本身的行為測試在範圍內（見「Evaluation harness」）。
