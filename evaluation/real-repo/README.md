# Real-repo Evaluation

用真實 PHP 專案驗證 Reviewer 的安全性與 reduction 效果。工具會在目標 repo 的檔案上自動產生大量帶標籤的變更（mutation），送進完整 pipeline（PHP analyzer → interpreters → reducer），再檢查決策是否符合標籤。

corpus 不保存完整檔案，但 edits 會包含目標 repo 的原始碼片段（例如被交換的參數運算式、字串內容、變數與參數名稱）。`corpus.jsonl`、各結果 `.jsonl` 與 `inspect` 的輸出都應視為與目標 repo 同等敏感，不要 commit 或分享到目標 repo 以外的地方；預設輸出目錄 `real-repo-eval-output/` 已列入 `.gitignore`。

## 快速開始

需要 PATH 上的 `php`（PHP CLI ≥ 8.3）與 Composer 2（前置需求見 [PR Review CLI](../../docs/review-cli.md#前置需求)）。generator 與 analyzer 都以 `php` 執行：找不到 `php` 時 `evaluate` / `generate` 立即失敗（exit 2）；單獨執行 `run` 時，空檔以外的每筆都是 `ANALYZER_ERROR`（空檔不執行 analyzer），以 gate failure（exit 1）結束。

目標專案不在本 repo 內，對真實目標專案執行的評估不在 `npm run test:all` 與 CI 中；`npm run test:all` 只以 `tests/evaluation/real-repo-*.test.js` 在 repo 內的 `fixtures/php-laravel` 與測試自建的小型 PHP 檔上測試這個工具本身與 gate。最近一次的量測結果見 [README「目前驗證基準」](../../README.md#目前驗證基準)。

```bash
npm run analyzer:install   # 第一次需要安裝 PHP analyzer 依賴

npm run eval:real-repo -- evaluate \
  --repo shop=/path/to/shop-api \
  --repo admin=/path/to/admin-api
```

輸出（預設在 `real-repo-eval-output/`）：

| 檔案 | 內容 |
|---|---|
| `corpus.jsonl` | 產生的 mutation，每行一筆；index 從 0 開始（第 N 行是 index N-1） |
| `candidate.jsonl` | 目前 working tree 版本的結果 |
| `baseline.jsonl` | 指定 `--baseline-ref` 時，該版本的結果 |
| `report.json` | summary、gate、比較結果 |

修改 analyzer 或 interpreter 後，建議與修改前的版本比較：

```bash
npm run eval:real-repo -- evaluate --repo shop=/path/to/shop-api --baseline-ref <base ref>   # 例如 origin/master、HEAD~1
```

`--baseline-ref` 以 `git archive` 取出 reviewer repo 該 ref 的 snapshot（不動目前的 working tree），再以 `tar` 解開，執行前先準備好，ref 不存在時立即失敗。因此另外需要 PATH 上的 `git` 與 `tar`，且執行這個工具的 reviewer 必須是 git checkout，不能是解壓縮的原始碼（例如 GitHub 的「Download ZIP」）；不符合時以 snapshot 失敗結束（exit 2）。snapshot 的 `composer.lock` 與目前相同、且目前已安裝 `analyzers/php/vendor/` 時直接複製 `vendor/`；否則執行 `composer install`，此時需要 `composer` 與網路。早於 AST analyzer 的版本（snapshot 沒有 `analyzers/php/composer.json` 的 token-based analyzer，例如 PR #6 合併前的 `master`；AST analyzer 從 PR #6 的 `bbc93a8` 開始）不需要安裝依賴。snapshot 在正常結束、發生錯誤或收到 Ctrl-C / SIGTERM 時都會被刪除；被 SIGKILL 強制結束時可能留在 `$TMPDIR/reviewer-baseline-*`，需手動刪除。

## 標籤與 gate

| label | 產生方式 | 期望 |
|---|---|---|
| `unchanged` | 每個檔案一筆，before = after | 必須 `NOT_SELECTED`；只有 generator 自己也無法解析（`parseable: false`，含空檔）時例外 |
| `safe` | 加註解、改縮排、參數換行、trailing comma、引號、method 內一致的區域變數改名 | 越多被 reduce 越好（Safe reduction rate） |
| `risky` | 移除 call / guard / 陣列元素、替換運算子、否定 `if` 條件、改字串或數字、交換參數、`return` 改成 `null`、在 `__LINE__` 所在行之前插入一行、部分改名、合併變數、參數改名、改名 `compact()` 引用的變數、改名 `global` 變數 | 絕不能 `NOT_SELECTED` |

報表 `op` 欄顯示的是 generator 的 op 名稱。每種 op 在每個檔案最多產生一筆，再依 `--rate` 抽樣；改名類 op 只在隨機挑選的一個 method 內產生，該 method 內有巢狀的 method（例如匿名 class）或在 method 內宣告的具名 function 時不產生（closure / arrow function 不受影響，其中的變數與 method 的變數一起改名）。

| op | label | 變更 |
|---|---|---|
| `S_UNCHANGED` | unchanged | 不修改 |
| `S_COMMENT` | safe | 在某個敘述的那一行之前插入一行註解 |
| `S_REINDENT` | safe | 以 4 個空白開頭的每一行，把這 4 個空白改成 tab |
| `S_WRAP_ARGS` | safe | 在 call 的第二個參數前換行 |
| `S_TRAILING_COMMA` | safe | 在陣列最後一個元素後加逗號 |
| `S_QUOTE_STYLE` | safe | 只含英數字、空白與 `_ . : -` 的單引號字串改成雙引號 |
| `S_RENAME_LOCAL` | safe | 一致改名 method 內的一個區域變數（加上 `Renamed`）；method 用到 `compact()`、`extract()` 等依賴變數名稱的函式、可變變數、`eval`、`include` / `require` 或 `global` 時不產生 |
| `R_REMOVE_CALL_STMT` | risky | 移除一個 method / static call 敘述 |
| `R_REMOVE_CHAINED_CALL` | risky | 移除鏈式呼叫的中間一段：`X->inner()->outer()` → `X->outer()` |
| `R_REMOVE_GUARD` | risky | 移除只含一個 `return` / `throw` / `exit` 的 `if`（沒有 `else` / `elseif`） |
| `R_REMOVE_ARRAY_ITEM` | risky | 移除陣列中最後一個以外的某個元素 |
| `R_FLIP_OPERATOR` | risky | 換成另一個運算子：`<`↔`<=`、`>`↔`>=`、`+`↔`-`、`&&`↔`\|\|`、`===`↔`!==`、`==`→`!=` |
| `R_NEGATE_CONDITION` | risky | 把 `if` 條件包成 `!(…)` |
| `R_CHANGE_STRING` | risky | 在字串的結束引號前加上 `X` |
| `R_CHANGE_INT` | risky | 整數字面值 +1 |
| `R_SWAP_ARGS` | risky | 交換 call 的前兩個參數（兩者都必須是位置參數，不是具名參數或 `...` 展開） |
| `R_RETURN_NULL` | risky | `return <expr>;` 改成 `return null;` |
| `R_SHIFT_LINE` | risky | 在含 `__LINE__` 的那一行之前插入一行註解。和 `S_COMMENT` 一樣只是註解，但 `__LINE__` 的值改變，所以是 risky |
| `R_RENAME_PARTIAL` | risky | 區域變數只改名其中一處 |
| `R_RENAME_MERGE` | risky | 把一個區域變數全部改名成同一 method 內的另一個區域變數 |
| `R_RENAME_PARAM` | risky | method 參數改名（宣告與 method 內的使用處一起改） |
| `R_RENAME_COMPACT` | risky | 一致改名被 `compact()` 以字串引用的變數（字串不變） |
| `R_RENAME_GLOBAL` | risky | 一致改名 `global` 宣告的變數（改指向另一個全域變數） |

標籤由 `generate.php` 獨立驗證：before / after 解析後去除所有 attributes 再 pretty print，safe（改名除外）必須相同、risky 必須不同，不符合的 mutation 直接捨棄。比較時 `__LINE__` 以實際行號、`__halt_compiler` 以 `__COMPILER_HALT_OFFSET__` 表示（排版變更會改變它們的值），`TRUE` / `true` 等常數名稱視為相同。safe 必須同時在最新 PHP 語法與 PHP 7 視角（7.4 語法、`#[` 視為註解）下成立，因為目標專案可能跑在 PHP 7 或 PHP 8。這個驗證刻意不使用 analyzer 的 `Canonicalizer`。

刻意接受的限制（analyzer 與 generator 都不視為行為差異）：排版變更造成例外訊息、backtrace 與匿名 class 名稱中的行號改變；透過 reflection 讀取的 closure `use` 變數與 `static` 變數名稱；PHP 5 的語意（只檢查 PHP 7 與 PHP 8 的解讀）；舊版 PHP 不支援的新語法（例如參數 trailing comma、`1_000`），這類問題請用目標 PHP 版本的 `php -l` 檢查。

Gate（任一項不為 0 時 gate 失敗）：

- `RISKY_REDUCED`：risky mutation 被判為 `NOT_SELECTED_FOR_HUMAN_REVIEW`（漏判，最嚴重）
- `ANALYZER_ERROR`：analyzer crash、逾時（`--timeout-ms`，預設 30000）或 pipeline 例外
- `UNCHANGED_NOT_REDUCED`：可解析的未變更檔案沒有被 reduce（代表誤報 fact 或解析問題；不採信受測 analyzer 自己回報的 parse error）
- `NO_ROWS_ANALYZED`：沒有任何一筆被實際分析（例如所有檔案都 `SOURCE_MISSING`）
- `REPO_NOT_ANALYZED`：多個 repo 時，某個 repo 沒有任何一筆被實際分析（例如該 `--repo` 指到錯誤的目錄）

`SOURCE_CHANGED` / `SOURCE_MISSING`（產生 corpus 後原始檔被修改或刪除）只列為 warning，該筆不分析。

## Exit code

| code | 意義 |
|---|---|
| 0 | 通過 |
| 1 | gate failure。`run`、`report` 檢查該指令產出或讀入的結果，所以 `run --baseline-ref` 在舊版本未通過 gate 時也會回傳 1；`evaluate` 只檢查 `candidate.jsonl`，baseline 的 gate 請用 `report --results baseline.jsonl` 檢查 |
| 2 | 參數錯誤、找不到 repo 路徑、analyzer 依賴未安裝、generator / snapshot / composer 失敗等執行錯誤 |
| 130 / 143 | 被 Ctrl-C（SIGINT）/ SIGTERM 中斷；使用 `--baseline-ref` 時會先刪除 snapshot 再結束 |

`compare` 的差異不影響 exit code（兩份結果的筆數或各 index 的 path / op 對不上、不是來自同一份 corpus 時，以 `COMPARE_CORPUS_MISMATCH` 結束，exit 2）。

## 掃描範圍

- 在 git work tree 內（包含位於其他 repo 底下的子目錄）以 `git ls-files '*.php'` 列出檔案：只包含已加入 index 的檔案，未追蹤的檔案不會被掃描，commit 進 repo 的 `vendor/` 則會被納入。不是 git repo 時遞迴掃描，略過 `.git`、`vendor`、`node_modules`。
- git 本身出錯（例如 dubious ownership、`git ls-files` 失敗）或找不到任何 PHP 檔時直接結束（exit 2），不會改用目錄掃描。
- 超過 300,000 bytes 的檔案與非 UTF-8 的路徑會略過，不產生任何資料列，只出現在 stderr 統計的 `tooLarge` 與 `nonUtf8Path`。
- `--rate`：每種 mutation 在每個檔案被抽樣的機率（預設 0.3）；`unchanged` 不抽樣。
- `--seed`：整數，預設 42。每個檔案以 seed 與路徑決定自己的亂數，相同 seed 與相同原始檔會產生完全相同的 mutation；新增或刪除其他檔案不影響既有檔案的 mutation。

## 報表欄位

各比例的分母是該 op 實際分析的筆數（n − errors − skipped）。

| 欄位 | 意義 |
|---|---|
| reduced | `NOT_SELECTED_FOR_HUMAN_REVIEW` 的比例 |
| targeted | Human Review、變更已被具體 fact 完整解釋（`TARGETED`）的比例 |
| full | Human Review、有無法自動解釋的變更或 analyzer 無法完整分析（`FULL`）的比例 |
| specific | decision reasons 含具體 domain blocker（不是 `COV-…`、`FACT_UNHANDLED:…` 等 generic fallback）的比例 |

`TARGETED` 與 `FULL` 都仍需 review 整個檔案；`bin/review.js` 對 `TARGETED` 檔案列出的位置只是 review 的起點（見 [PR Review CLI](../../docs/review-cli.md)），這份報表只統計比例、不列出位置。目前的 reduction 只到檔案層級（見 [README「目前能力邊界」](../../README.md#目前能力邊界)），只有 reduced（`NOT_SELECTED_FOR_HUMAN_REVIEW`）代表 review 範圍真的縮小。

摘要中的 Risky targeted rate 是 risky mutation 以 `TARGETED`（而非 `FULL`）送 Human Review 的比例，衡量的是變更被具體 fact 解釋的程度，不是 review 工作量的減少。

## 個別指令

```bash
CLI="node evaluation/real-repo/cli.js"
OUT=real-repo-eval-output

$CLI generate --repo shop=/path/to/shop-api --seed 42 --rate 0.3 --out $OUT/corpus.jsonl
$CLI run --corpus $OUT/corpus.jsonl --repo shop=/path/to/shop-api --out $OUT/candidate.jsonl
$CLI run --corpus $OUT/corpus.jsonl --repo shop=/path/to/shop-api --baseline-ref HEAD~3 --out $OUT/baseline.jsonl
$CLI report --results $OUT/candidate.jsonl
$CLI compare --baseline-results $OUT/baseline.jsonl --candidate-results $OUT/candidate.jsonl
$CLI inspect --corpus $OUT/corpus.jsonl --repo shop=/path/to/shop-api \
  --results $OUT/baseline.jsonl --results $OUT/candidate.jsonl 120 451
```

- 每個指令都可加 `--help`；`--out` 的上層目錄不存在時會自動建立。
- `--repo` 格式為 `label=path`，可重複指定多個 repo：label 只能含英數字與 `.` `_` `-`，path 不可為空（否則 `REPO_OPTION_INVALID`）；label 不可重複（`REPO_LABEL_DUPLICATED`）。
- `run --reviewer <dir>`：改用另一份 reviewer checkout（例如另一個 worktree）執行 corpus，不建立 `git archive` snapshot。該 checkout 若有 `analyzers/php/composer.json`（AST analyzer 之後的版本），必須已執行 `npm run analyzer:install`，否則以 `ANALYZER_DEPENDENCY_MISSING` 結束（exit 2）；更早的版本不需要依賴。`--reviewer` 與 `--baseline-ref` 只能擇一，同時指定時為 `OPTION_CONFLICT`（exit 2）。
- `report --json`、`compare --json`：改以 JSON 輸出到 stdout。`report` 輸出 `{summary, gate}`，gate 失敗時 exit code 仍為 1；`compare` 輸出比較結果（`total`、`identical`、`categories`、`transitions`、`newReductions`、`lostReductions`）。
- `evaluate` 在 gate 失敗時，會在報表後自動對前 3 筆有 index 的失敗（`RISKY_REDUCED`、`ANALYZER_ERROR`、`UNCHANGED_NOT_REDUCED`）印出 `inspect` 結果，只含 candidate 的結果；`NO_ROWS_ANALYZED`、`REPO_NOT_ANALYZED` 沒有 index，不會印出。其餘失敗請用 `inspect` 指令查看。
- `--concurrency`：同時執行的 analyzer 數（預設為 CPU 數，最多 8）。
- `compare` 以「第一個不同的欄位」分類，依序為 `outcome`、`decision`、`fallback`、`complete`（含 reasonCode）、`reasons`、`facts`、`subjects`，並列出 decision 轉換與新增 / 失去的 reduction。
- `inspect` 顯示 edit 前後的原始碼片段與各版本的結果，用來追查 gate failure 或比較差異；`--repo` 可省略（只顯示結果），原始檔已被修改時不顯示片段。
