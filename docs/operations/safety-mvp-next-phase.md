# Safety MVP Next Phase 操作與失敗處理

## 生產責任邊界

authoritative publication 的完整流程固定為（PR review CLI 不走這個流程，見下節）：

```text
Adapter execution
  -> AdapterResult validation
  -> normalization / context binding
  -> deterministic core
  -> authority CAS store
  -> authoritative Summary + status check
  -> optional GitHub sink
```

Adapter、evidence、impact、invariant 與 GitHub sink 都不能直接改寫 reduction decision。只有 CAS 成功的 candidate 才能成為 authoritative candidate；sink 是 delivery-only，不會回頭改寫 authority 或 check。

這條流程目前是 library entry point（`src/runner.js` 的 `runStoredAdapterPipeline`，注入 authority store 與 optional transport）。repo 內沒有呼叫它的 CLI 或 service，只有測試會用到：`tests/pipeline.test.js` 與 `tests/e2e/adapter-to-github.test.js` 以測試用 store 與 fake transport 執行它，`tests/storage.test.js` 直接測試兩個 store；也沒有實際呼叫 GitHub API 的 transport，正式環境需由整合方注入 `upsertSummary` / `upsertCheck` 的實作。

## PR review CLI（`bin/review.js`）

`bin/review.js` 是目前唯一的產品入口（`bin/` 下只有它；`evaluation/` 下的 runner 是驗證工具）：對一個 PR 的每個變更檔案做 review scope 決策，比較範圍與 GitHub PR 相同，從 `git merge-base <base> <head>` 算到 head。用法、選項、exit code、原因代碼、JSON 報表與 CI 用法見 [PR Review CLI](../review-cli.md)。這裡只記錄它和上面 authoritative 流程的差別：

- 只有修改或 rename 的 `.php` 檔會送進 analyzer。每個檔案各自執行一次 `runAdapterPipeline`，搭配當次建立、用完即丟的記憶體 authority state（`createAuthorityState`，本地 identity：`policyId: 'pr-review'`，`baseSha` 為 merge base），只取 candidate 的 decision。
- CLI **不經過** `SqliteAuthorityStore` 的 persisted CAS，不產生 authoritative Summary 或 Status Check，也不呼叫 GitHub sink；結果只輸出到 stdout 與 `--out` 的檔案。本文「Authority 與 CAS」「Summary、status check 與 sink」兩節的保證不適用於 CLI 報表，`AUTHORITY_CAS_*` 與 `GITHUB_PUBLICATION_FAILED` 也只屬於 authoritative 流程。
- 新增、刪除、非 PHP、binary、symlink、submodule 與 type change 的檔案不經 analyzer，一律 `FULL`。rename 與權限變更即使內容等價也要求 review（`FILE_RENAMED` / `FILE_MODE_CHANGED`）。CLI 只會把 pipeline 的決策往更嚴格的方向調整，不會放寬。
- 決策是 file-level。`TARGETED` 表示檔案中每個變更都已被具體 fact 解釋，列出的位置是 review 的起點；`FULL` 表示至少有一個變更無法解釋，或檔案沒有（或無法）分析。兩者都要 review 整個檔案。PR 層級只有在**所有**檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才不需要 review。
- analyzer 的問題（找不到 `php`、缺少依賴、逾時）不會讓 CLI 以 exit code 2 結束，而是讓該檔變成 `FULL`；在 CI 中使用時需另外檢查（見下方「Incident handling」與 [PR Review CLI「在 CI 中使用」](../review-cli.md#在-ci-中使用)）。
- 本 repo 的 CI 只跑下一節的 release gate，不會在 PR 上執行 `bin/review.js`。

## Release gate

本地與 CI 都必須先安裝 PHP analyzer 的 Composer 依賴，再執行 `test:all`。本地：

```bash
npm ci
npm run analyzer:install   # composer install --working-dir=analyzers/php --no-interaction
npm run test:all
```

- 需要 PATH 上的 `php`（PHP CLI ≥ 8.3，`analyzers/php/composer.json` 的要求）、Composer 2，以及 `git`（review CLI 的測試會建立暫時的 git repository）。analyzer 依賴為 `nikic/php-parser` 5.9.0，版本鎖定在 `analyzers/php/composer.lock`；`analyzers/php/vendor/` 不進版控。
- 缺少 `analyzers/php/vendor/autoload.php` 時 analyzer 以 `PHP_ANALYZER_DEPENDENCY_MISSING` fail-closed。PHP adapter 測試、`eval:mutations` 與 `eval:historical` 都使用真實 analyzer，因此沒有安裝依賴時 release gate 無法通過。

`test:all` 依序執行 `lint`（ESLint，只檢查 JS）、`test:safety`、`test:e2e`、`test:coverage`、`eval:mutations`、`eval:historical`。`test:safety` 使用遞迴 `node --test`，`test:e2e` 明確執行 `tests/e2e/*.test.js`（Node.js 24.3 不接受目錄作為 test input），`test:coverage` 的最低門檻為 lines/functions/statements 90%、branches 85%。`test:all` 執行時不依賴網路、LLM、真實 GitHub token 或 production credential；只有 `npm ci` 與 `npm run analyzer:install` 安裝依賴時需要網路。

CI（`.github/workflows/review-reduction-safety.yml`，Node.js 24、PHP 8.4、Composer 2）依序執行 `npm ci`、`composer install --working-dir=analyzers/php --no-interaction --no-progress --prefer-dist`、對 `analyzers/php/bin`、`analyzers/php/src` 與 `evaluation` 下每個 `.php` 檔執行 `php -l`，最後執行 `npm run test:all`。`php -l` 沒有對應的 npm script，本地可用同一行指令檢查：

```bash
find analyzers/php/bin analyzers/php/src evaluation -name '*.php' -print0 | xargs -0 -n1 php -l
```

### Real-repo evaluation（不屬於 release gate）

`npm run eval:real-repo` 在外部真實 PHP 專案的檔案上自動產生帶標籤的 mutation，走完整 pipeline（PHP analyzer → interpreters → reducer）並檢查決策。它需要不在本 repo 內的目標專案，所以不在 `test:all` 與 CI 中：release gate 通過不代表真實專案上的 reduction safety 已重新驗證。修改 PHP analyzer 或 interpreter 時，建議另外在本機對目標專案執行，並與修改前的版本比較：

```bash
npm run eval:real-repo -- evaluate --repo <label>=/path/to/project --baseline-ref <base ref>
```

- gate 的任一項（`RISKY_REDUCED`、`ANALYZER_ERROR`、`UNCHANGED_NOT_REDUCED`、`NO_ROWS_ANALYZED`、`REPO_NOT_ANALYZED`）不為 0 即失敗，exit code 1；參數錯誤、analyzer 依賴未安裝、generator / snapshot / composer 失敗等執行錯誤為 exit code 2。`evaluate` 只對 `candidate.jsonl` 判定 gate，baseline 需另外以 `report --results baseline.jsonl` 檢查。
- `--baseline-ref` 的 snapshot 在 `composer.lock` 與目前不同、或目前沒有安裝 `analyzers/php/vendor/` 時會執行 `composer install`，需要 `composer` 與網路。
- 輸出（預設 `real-repo-eval-output/`，已列入 `.gitignore`）含目標專案的原始碼片段，應視為與目標專案同等敏感，不得 commit 或分享到目標專案以外。

完整說明見 [Real-repo Evaluation](../../evaluation/real-repo/README.md)。

## Authority 與 CAS

- `MemoryAuthorityStore` 只用於 deterministic unit/integration tests。
- `SqliteAuthorityStore` 以唯一 repository row 保存 current head、context binding、candidate digest 與 candidate JSON。
- `advanceCurrentHead()` 在同一 transaction 驗證 expected head、切換新 head 並清除舊 candidate。
- `compareAndSwapCurrent()` 只在 persisted head 與 context binding 都相符時寫入。
- stale candidate 回傳 `AUTHORITY_CAS_STALE`；同一 head 不同 digest 回傳 `AUTHORITY_CAS_CONFLICT`；兩者都不得修改 authority。
- 同一 head/digest 重試回傳 idempotent success，並重用同一 authoritative candidate。
- `bin/review.js` 與 mutation、historical、real-repo evaluation 都只使用 `createAuthorityState` 建立的一次性記憶體 state，不使用上述兩個 store。

SQLite database 重啟後必須先讀回 current head，再處理新的 run。正式環境應由外部備份策略保護 database 檔案；測試使用 temporary database，測試結束即清理，不得把測試檔案當成 production backup。

## Summary、status check 與 sink

`PASS` 只代表 candidate、Summary、Status Check 與 current authority 的 identity、context binding、digest 綁定正確，不代表 decision 是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。`ANALYSIS_FAILED`、stale、Summary 發布失敗都必須維持 failure 語意。

GitHub publisher 使用 provider-neutral `upsertSummary` / `upsertCheck` port，request 固定帶有：

- marker：`REVIEW_REDUCTION_SAFETY`
- repository
- head SHA
- candidate digest
- authoritative Summary
- status check

transport 的非 2xx、timeout、exception、malformed response 或 conflict 都只回傳 `GITHUB_PUBLICATION_FAILED`。retry 是否去重由 marker + head SHA + candidate digest 交給 transport 實作；publisher 不假設 GitHub 原生提供任意 idempotency key。

## Incident handling

| Reason | 意義 | 安全行為 |
|---|---|---|
| `ANALYSIS_FAILED` | 分析輸入或 execution 不可信 | Full Review、check FAILURE |
| `AUTHORITY_CAS_STALE` | run 不是 current head | no-op，不建立 Summary/sink delivery |
| `AUTHORITY_CAS_CONFLICT` | 同 head 已有不同 candidate digest | 保留既有 authority，人工處理衝突 |
| `GITHUB_PUBLICATION_FAILED` | 外部 delivery 未確認成功 | authority 不變，可用相同 head/digest retry |

PHP analyzer 的常見失敗。前兩列是 `ANALYSIS_FAILED`（CLI 中為 `FULL`）的具體成因，不是新的 eligibility 狀態：

| Reason | 意義 | 安全行為 |
|---|---|---|
| `COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING` | `analyzers/php/vendor/autoload.php` 不存在（未執行 `npm run analyzer:install`）。adapter 回報 FAILED 的 `COV-PHP-001` obligation，coverage FAILED | 每個送進 analyzer 的 PHP 檔都 fail-closed：authoritative 流程為 `ANALYSIS_FAILED`、Full Review、check FAILURE；`bin/review.js` 中該檔為 `FULL`，exit code 不變。執行 `npm run analyzer:install` 後重新分析，不得把這次結果當成已完成分析 |
| `ANALYZER_ERROR:<訊息>`（`bin/review.js` 的檔案原因） | analyzer 執行時丟出例外：找不到 `php`（`spawn php ENOENT`）、逾時（`PHP_ANALYZER_ABORTED`）、非 0 結束（`PHP_ANALYZER_EXIT_<code>`，例如 PHP 低於 8.3）、輸出不是 JSON（`PHP_ANALYZER_OUTPUT_INVALID`）。authoritative 流程中同樣的失敗由 adapter runner 轉成 `ADAPTER_EXCEPTION` / `ADAPTER_EXECUTION_TIMEOUT`，歸入 `ANALYSIS_FAILED` | 該檔為 `FULL`，exit code 不是 2。確認 PHP CLI ≥ 8.3 與 analyzer 依賴後重跑；逾時可調高 `--timeout-ms` |
| `ANALYZER_DEPENDENCY_MISSING:<路徑>`（`npm run eval:real-repo`） | 受測 reviewer checkout（目前的 checkout，或 `run --reviewer <dir>` 指定的目錄）沒有安裝 analyzer 依賴 | evaluation 以 exit code 2 結束，不產生結果；在該 checkout 執行 `npm run analyzer:install` 後重跑 |

不應以重跑或手動重送來掩蓋 stale/conflict；先確認 persisted current head 與 candidate digest，再決定是否建立新 run。
