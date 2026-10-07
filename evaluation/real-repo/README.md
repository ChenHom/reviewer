# Real-repo Evaluation

用真實 PHP 專案驗證 Reviewer 的安全性與 reduction 效果。工具會在目標 repo 的檔案上自動產生大量帶標籤的變更（mutation），送進完整 pipeline（PHP analyzer → interpreters → reducer），再檢查決策是否符合標籤。

corpus 不保存完整檔案，但 edits 會包含目標 repo 的原始碼片段（例如被交換的參數運算式、字串內容、變數與參數名稱）。`corpus.jsonl`、各結果 `.jsonl` 與 `inspect` 的輸出都應視為與目標 repo 同等敏感，不要 commit 或分享到目標 repo 以外的地方；預設輸出目錄 `real-repo-eval-output/` 已列入 `.gitignore`。

## 快速開始

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
npm run eval:real-repo -- evaluate --repo shop=/path/to/shop-api --baseline-ref origin/main
```

`--baseline-ref` 以 `git archive` 取出該 ref 的 snapshot（不動目前的 working tree），執行前先準備好，ref 不存在時立即失敗。snapshot 的 `composer.lock` 與目前相同時直接複製 `vendor/`；不同時會執行 `composer install`，此時需要 `composer` 與網路。snapshot 在結束時一定會被刪除。

## 標籤與 gate

| label | 產生方式 | 期望 |
|---|---|---|
| `unchanged` | 每個檔案一筆，before = after | 必須 `NOT_SELECTED`；只有 generator 自己也無法解析（`parseable: false`，含空檔）時例外 |
| `safe` | 加註解、改縮排、參數換行、trailing comma、引號、method 內一致的區域變數改名 | 越多被 reduce 越好（Safe reduction rate） |
| `risky` | 移除 call / guard / 陣列元素、反轉運算子、改字串或數字、交換參數、部分改名、合併變數、參數改名、改名 `compact()` 引用的變數、改名 `global` 變數… | 絕不能 `NOT_SELECTED` |

標籤由 `generate.php` 獨立驗證：before / after 解析後去除所有 attributes 再 pretty print，safe（改名除外）必須相同、risky 必須不同，不符合的 mutation 直接捨棄。比較時 `__LINE__` 以實際行號、`__halt_compiler` 以 byte offset 表示（排版變更會改變它們的值），`TRUE` / `true` 等常數名稱視為相同。這個驗證刻意不使用 analyzer 的 `Canonicalizer`。

排版變更仍會改變例外訊息與 backtrace 中的行號；這類只影響除錯資訊的差異視為可接受，`__LINE__` 這種把行號當成值的寫法則不行。

Gate（任一項不為 0 時 gate 失敗）：

- `RISKY_REDUCED`：risky mutation 被判為 `NOT_SELECTED_FOR_HUMAN_REVIEW`（漏判，最嚴重）
- `ANALYZER_ERROR`：analyzer crash、逾時（`--timeout-ms`，預設 30000）或 pipeline 例外
- `UNCHANGED_NOT_REDUCED`：可解析的未變更檔案沒有被 reduce（代表誤報 fact 或解析問題；不採信受測 analyzer 自己回報的 parse error）
- `NO_ROWS_ANALYZED`：沒有任何一筆被實際分析（例如所有檔案都 `SOURCE_MISSING`）

`SOURCE_CHANGED` / `SOURCE_MISSING`（產生 corpus 後原始檔被修改或刪除）只列為 warning，該筆不分析。

## Exit code

| code | 意義 |
|---|---|
| 0 | 通過 |
| 1 | gate failure。`evaluate`、`run`、`report` 會檢查**該指令產出或讀入的結果**，所以 `run --baseline-ref` 在舊版本未通過 gate 時也會回傳 1 |
| 2 | 參數錯誤、找不到 repo 路徑、generator / snapshot / composer 失敗等執行錯誤 |

`compare` 只輸出差異，不影響 exit code。

## 掃描範圍

- git repo 以 `git ls-files '*.php'` 列出檔案（尊重 `.gitignore`；commit 進 repo 的 `vendor/` 也會被納入）；不是 git repo 時遞迴掃描，略過 `.git`、`vendor`、`node_modules`。在 git repo 中 `git ls-files` 失敗會直接報錯，不會改用目錄掃描。
- 超過 300,000 bytes 的檔案與非 UTF-8 的路徑會略過，不產生任何資料列（只出現在 stderr 的 `tooLarge` 統計）。
- `--rate`：每種 mutation 在每個檔案被抽樣的機率（預設 0.3）；`unchanged` 不抽樣。
- `--seed`：每個檔案以 seed 與路徑決定自己的亂數，相同 seed 與相同原始檔會產生完全相同的 mutation；新增或刪除其他檔案不影響既有檔案的 mutation。

## 報表欄位

各比例的分母是該 op 實際分析的筆數（n − errors − skipped）。

| 欄位 | 意義 |
|---|---|
| reduced | `NOT_SELECTED_FOR_HUMAN_REVIEW` 的比例 |
| targeted | Human Review、只需看指定位置（`TARGETED`）的比例 |
| full | Human Review、需要完整 review（`FULL`）的比例 |
| specific | decision reasons 含具體 domain blocker（不是 `COV-…`、`FACT_UNHANDLED:…` 等 generic fallback）的比例 |

摘要中的 Risky targeted rate 是 risky mutation 以 `TARGETED`（而非 `FULL`）送 Human Review 的比例。

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

- 每個指令都可加 `--help`。
- `--concurrency`：同時執行的 analyzer 數（預設為 CPU 數，最多 8）。
- `compare` 以「第一個不同的欄位」分類，依序為 `outcome`、`decision`、`fallback`、`complete`（含 reasonCode）、`reasons`、`facts`、`subjects`，並列出 decision 轉換與新增 / 失去的 reduction。
- `inspect` 顯示 edit 前後的原始碼片段與各版本的結果，用來追查 gate failure 或比較差異；`--repo` 可省略（只顯示結果），原始檔已被修改時不顯示片段。
