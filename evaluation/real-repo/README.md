# Real-repo Evaluation

用真實 PHP 專案驗證 Reviewer 的安全性與 reduction 效果。工具會在目標 repo 的檔案上自動產生大量帶標籤的變更（mutation），送進完整 pipeline（PHP analyzer → interpreters → reducer），再檢查決策是否符合標籤。

目標 repo 的原始碼不會被複製進本 repo；corpus 只記錄檔案路徑、原始檔 sha256 與 byte-range edits。

## 快速開始

```bash
npm run analyzer:install   # 第一次需要安裝 PHP analyzer 依賴

npm run eval:real-repo -- evaluate \
  --repo shop=/path/to/shop-api \
  --repo admin=/path/to/admin-api
```

輸出（預設在 `real-repo-eval-output/`，已列入 `.gitignore`）：

| 檔案 | 內容 |
|---|---|
| `corpus.jsonl` | 產生的 mutation（每行一筆，行號即 index） |
| `candidate.jsonl` | 目前 working tree 版本的結果 |
| `baseline.jsonl` | 指定 `--baseline` 時，該版本的結果 |
| `report.json` | summary、gate、比較結果 |

修改 analyzer 或 interpreter 後，建議與修改前的版本比較：

```bash
npm run eval:real-repo -- evaluate --repo shop=/path/to/shop-api --baseline origin/main
```

`--baseline` 以 `git archive` 取出該 ref 的 snapshot（不動目前的 working tree），PHP 依賴與目前相同時直接複製 `vendor/`，不同時執行 `composer install`。

## 標籤與 gate

| label | 產生方式 | 期望 |
|---|---|---|
| `unchanged` | 每個檔案一筆，before = after | 必須 `NOT_SELECTED`（無法解析或空檔除外） |
| `safe` | 加註解、改縮排、參數換行、trailing comma、引號、method 內一致的區域變數改名 | 越多被 reduce 越好（Safe reduction rate） |
| `risky` | 移除 call / guard / 陣列元素、反轉運算子、改字串或數字、交換參數、部分改名、合併變數、參數改名… | 絕不能 `NOT_SELECTED` |

標籤由 `generate.php` 獨立驗證：before / after 解析後去除所有 attributes 再 pretty print，safe（改名除外）必須相同、risky 必須不同，不符合的 mutation 直接捨棄。這個驗證刻意不使用 analyzer 的 `Canonicalizer`。

Gate（任一項不為 0 時 exit code 為 1）：

- `RISKY_REDUCED`：risky mutation 被判為 `NOT_SELECTED_FOR_HUMAN_REVIEW`（漏判，最嚴重）
- `ANALYZER_ERROR`：analyzer crash 或 pipeline 例外
- `UNCHANGED_NOT_REDUCED`：未變更的檔案沒有被 reduce（代表誤報 fact 或解析問題）

`SOURCE_CHANGED` / `SOURCE_MISSING`（產生 corpus 後原始檔被修改或刪除）只列為 warning，該筆不分析。

## 報表欄位

| 欄位 | 意義 |
|---|---|
| reduced | `NOT_SELECTED_FOR_HUMAN_REVIEW` 的比例 |
| targeted | Human Review、只需看指定位置（`TARGETED`）的比例 |
| full | Human Review、需要完整 review（`FULL`）的比例 |
| specific | decision reasons 含具體 domain blocker（不是 `COV-…`、`FACT_UNHANDLED:…` 等 generic fallback）的比例 |

## 個別指令

```bash
CLI="node evaluation/real-repo/cli.js"

$CLI generate --repo shop=/path/to/shop-api --seed 42 --rate 0.3 --out corpus.jsonl
$CLI run --corpus corpus.jsonl --repo shop=/path/to/shop-api --out candidate.jsonl
$CLI run --corpus corpus.jsonl --repo shop=/path/to/shop-api --baseline HEAD~3 --out baseline.jsonl
$CLI report --results candidate.jsonl
$CLI compare --baseline baseline.jsonl --candidate candidate.jsonl
$CLI inspect --corpus corpus.jsonl --repo shop=/path/to/shop-api \
  --results baseline.jsonl --results candidate.jsonl 120 451
```

- `--rate`：每種 mutation 在每個檔案被抽樣的機率（預設 0.3）；`unchanged` 不抽樣。
- `--seed`：相同 seed 與相同原始檔會產生完全相同的 corpus。
- `--concurrency`：同時執行的 analyzer 數（預設為 CPU 數，最多 8）。
- `compare` 以「第一個不同的欄位」分類（`decision`、`fallback`、`complete`、`reasons`、`facts`、`subjects`），並列出 decision 轉換與新增 / 失去的 reduction。
- `inspect` 顯示 edit 前後的原始碼片段與各版本的結果，用來追查 gate failure 或比較差異。
