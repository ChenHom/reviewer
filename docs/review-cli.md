# PR Review CLI（`bin/review.js`）

`bin/review.js` 對一個 PR（base 與 head 兩個 git ref）的每個變更檔案做 review scope 決策：哪些檔案需要 Human Review、原因是什麼、從哪裡開始看。

本文是這個 CLI 的完整參考：前置需求、用法與選項、比較範圍、檔案分類、決策語意、原因代碼、文字與 JSON 輸出、exit code、CI 用法與限制。其他文件以本文為準，只做摘要並連到這裡。

實作位置：

- `bin/review.js`：參數解析、輸出與 exit code。
- `src/review/git.js`：解析 ref、merge base、`git diff`、讀取 blob。
- `src/review/review.js`：逐檔決策（`classifyEntry` / `reviewEntry`）、PR 層級彙整（`summarizeFiles`）、`reviewRange()`。
- `src/review/format.js`：文字輸出。
- 測試：`tests/review/review.test.js`。

## 做什麼、不做什麼

- 決策單位是**檔案**（file-level review scope reduction）。每個檔案只會是 `NOT_SELECTED_FOR_HUMAN_REVIEW`，或是 `HUMAN_REVIEW_REQUIRED` 加上 `TARGETED` / `FULL` 其中之一。
- 只有 `.php` 檔的修改與 rename 會送進 PHP analyzer（binary 除外）；其他變更一律 `FULL`。
- 輸出中的行號（「變更位置」與 fact 位置）是 review 的**起點**，不是 review 範圍。blocker 尚未建立 `blocker → factId → provenance` 的 region-level contract（見 [README「目前能力邊界」](../README.md#目前能力邊界)），所以不能解讀成「只有標示的行需要看」：需要 review 的檔案都要看整個檔案。
- CLI 只讀取 git 物件，結果輸出到 stdout（與 `--out` 指定的檔案），不會發布到 GitHub（不留言、不建立 check）。

## 前置需求

- `git`，在 PATH 上。
- Node.js。CLI 用到 `os.availableParallelism`，至少需要 Node 18.14；`package.json` 沒有宣告 `engines`，只有 CI 使用的 Node 24 經過測試。CLI 只用 Node 內建模組與本 repo 的 `src/`，執行時不需要 `npm install`（`npm ci` 是給 lint 與測試用的）。
- PHP CLI 8.3 以上，以 `php` 的名稱放在 PATH 上（`analyzers/php/composer.json` 要求 `php >= 8.3`；CI 使用 PHP 8.4）。
- Composer 2，用來安裝 analyzer 依賴（[nikic/php-parser](https://github.com/nikic/PHP-Parser) 5.9.0，版本鎖定在 `analyzers/php/composer.lock`）：

  ```bash
  npm run analyzer:install   # composer install --working-dir=analyzers/php，再 npm ci --prefix analyzers/ts
  ```

- TypeScript / JavaScript 檔案的 analyzer（`analyzers/ts`）以執行 CLI 的同一個 Node.js 執行，依賴 `typescript` 5.9.3（版本鎖定在 `analyzers/ts/package-lock.json`），同樣由 `npm run analyzer:install` 安裝。沒有安裝時每個送進 TS analyzer 的檔案為 `FULL`（`COV-TS-001:TS_ANALYZER_DEPENDENCY_MISSING`）。

- 要 review 的 repository 必須同時有 base 與 head 的歷史，才找得到 merge base（見「比較範圍」）。

PHP 相關的前置需求不滿足時，CLI **不會**以錯誤結束，而是把每個送進 analyzer 的 PHP 檔判為 `FULL`：

| 狀況 | 檔案的原因代碼 |
|---|---|
| PATH 上沒有 `php` | `ANALYZER_ERROR:spawn php ENOENT` |
| 沒有執行 `npm run analyzer:install`（`analyzers/php/vendor` 不存在） | `COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING` |
| PATH 上的 `php` 低於 8.3：PHP 8.0–8.2 在依賴已安裝時（`analyzers/php/vendor` 存在，例如之前以其他 PHP 版本安裝），由 Composer 的 platform check 讓 analyzer 以非 0 結束；PHP 7 以下連 analyzer 本身都無法解析（PHP 的 Parse error），不會走到 platform check。以 PHP 8.0–8.2 執行 `npm run analyzer:install` 會因 `php >= 8.3` 的 platform requirement 失敗、不會建立 `vendor`，這時的原因是上一列的 `COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING` | `ANALYZER_ERROR:PHP_ANALYZER_EXIT_<code>:…` |

這時 exit code 為 0；加上 `--fail-on-review` 時為 1，與「真的需要 review」無法區分。CI 中請另外檢查，見「在 CI 中使用」。

## 用法

```bash
node bin/review.js --base <ref> [--head HEAD] [--repo .] [options]
```

例：

```bash
node bin/review.js --repo /path/to/project --base origin/master --head HEAD
```

| 選項 | 預設 | 說明 |
|---|---|---|
| `--base <ref>` | 必填 | PR 的目標分支，例如 `origin/master`。缺少或為空字串時以 `OPTION_MISSING:--base` 結束 |
| `--head <ref>` | `HEAD` | 要 review 的版本 |
| `--repo <path>` | 目前目錄 | git repository 內的任一路徑。指定子目錄也一樣 review 整個 repository |
| `--json` | 關 | stdout 改為輸出 JSON 報表（取代文字輸出） |
| `--out <file>` | 無 | 另外把 JSON 報表寫到檔案。不論有沒有 `--json` 都是同一份 JSON；上層目錄不存在時會自動建立 |
| `--fail-on-review` | 關 | PR 層級決策為 `HUMAN_REVIEW_REQUIRED` 時 exit code 為 1 |
| `--fail-on-escalation` | 關 | PR 層級路由為 `ESCALATED`（有檔案命中單向門，AI 審查後必須人工確認，見「路由」）時 exit code 為 1 |
| `--concurrency <n>` | CPU 數與 8 取小者 | 同時執行的 analyzer process 數；整數 1–64。不影響結果與輸出順序 |
| `--timeout-ms <n>` | `30000` | 單一檔案的 analyzer deadline（毫秒）；整數 1–2147483647。逾時的 analyzer 會被終止，該檔案為 `FULL`，原因 `ANALYZER_ERROR:PHP_ANALYZER_ABORTED` |
| `--help`、`-h` | | 印出用法並以 0 結束（忽略其他參數） |

- ref 以 `git rev-parse --verify <ref>^{commit}` 解析：branch、remote branch、tag、commit SHA、`HEAD~1` 都可以。
- 以 `-` 開頭的 ref 一律被拒絕（`GIT_REF_INVALID`）。選項值本身以 `-` 開頭時必須寫成 `--base=-x`，`--base -x` 會先被參數解析拒絕。
- `--concurrency` / `--timeout-ms` 不是範圍內的整數時以 `OPTION_INVALID` 結束。

## 比較範圍：merge base

與 GitHub PR 的「Files changed」相同，CLI review 的是 head 相對於 base 與 head 的 **merge base** 的變更，等同 `git diff <base>...<head>`：

```
git merge-base <base> <head>    → 比較起點（報表的 mergeBase）
git diff -M <mergeBase> <head>  → 要 review 的檔案
```

- 分支建立後才進入 base 的 commit 不算在這次 review 裡。
- 報表的 `base.sha` 仍是 `--base` 指向的 commit；`mergeBase` 才是實際的比較起點。輸出中 `base:` 的行號是 merge base 版本的行號。
- 文字輸出的第二行標示比較範圍。merge base 與 base 不同時，加上「比較起點」：

  ```
  shop  main (48016bdb0fe7) → feature (594959a22beb)，比較起點為 merge base ec4021f968a4
  ```

  base 是 head 的祖先（例如 PR 分支已經 rebase 到最新的 base）時，merge base 就是 base，不會有後半段。
- 只比較 commit：working tree 與 index 中未 commit 的變更不會被 review。
- head 已經包含在 base 中（merge base 等於 head）時沒有任何變更，PR 決策為 `NOT_SELECTED_FOR_HUMAN_REVIEW`，原因 `NO_CHANGES`。
- base 與 head 沒有共同祖先時以 `GIT_NO_MERGE_BASE` 結束（exit code 2）。除了真的不相關的歷史，常見原因是 shallow clone：base 有 fetch，但歷史不夠深，到不了 merge base。
- shallow clone 也可能根本沒有 base：`actions/checkout` 預設 `fetch-depth: 1`，只抓要 checkout 的那一個 commit，不會有 `origin/<base 分支>`，base 的 commit 也不在 repository 中。這時在解析 ref 時就以 `GIT_FAILED:git rev-parse: fatal: Needed a single revision` 結束，不會走到 merge base。
- 這兩種情況都請抓取完整歷史（`fetch-depth: 0`），或 fetch base 並加深到包含 merge base。
- rename 以 `git diff -M` 偵測（git 預設相似度 50%）。相似度不足的改名會變成一個刪除加一個新增（PHP 檔為 `FILE_DELETED` 與 `FILE_ADDED`）。

## 檔案分類

`git diff` 的每一筆變更依下列順序判斷，第一個符合的條件決定結果：

| 順序 | 條件 | 結果 | 原因代碼 |
|---|---|---|---|
| 1 | git 狀態不是新增、刪除、修改或 rename。實際會遇到的是 `type-changed`（一般檔案、symlink、submodule 之間互換） | `FULL` | `UNSUPPORTED_CHANGE_TYPE:<status>` |
| 2 | 任一側是 submodule（mode `160000`） | `FULL` | `SUBMODULE_CHANGED` |
| 3 | 任一側是 symlink（mode `120000`） | `FULL` | `SYMLINK_CHANGED` |
| 4 | 路徑不是支援的語言（不分大小寫；rename 看新路徑）：PHP 為 `.php`；TypeScript / JavaScript 為 `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs`、`.cjs`，但型別宣告檔（`.d.ts`、`.d.mts`、`.d.cts`）除外 | `FULL` | `UNSUPPORTED_FILE_TYPE` |
| 5 | 新增的檔案 | `FULL` | `FILE_ADDED` |
| 6 | 刪除的檔案 | `FULL` | `FILE_DELETED` |
| 7 | 任一側內容含 NUL byte | `FULL` | `BINARY_FILE` |
| 8 | analyzer 執行失敗（找不到 `php`、逾時、非 0 結束、輸出不是 JSON） | `FULL` | `ANALYZER_ERROR:<訊息>` |
| 9 | 其餘：修改或 rename 的檔案，由該語言的 analyzer 比較 merge base 與 head 兩個版本 | 見下 | 見「原因代碼」 |

第 1–8 步的檔案在 JSON 中 `analyzed` 為 `false`、`facts` 為空。因為判斷順序：

- 新增或刪除的非 PHP 檔是 `UNSUPPORTED_FILE_TYPE`，不是 `FILE_ADDED` / `FILE_DELETED`。
- 新增、刪除或改指向的 symlink 是 `SYMLINK_CHANGED`；一般檔案改成 symlink 則是 `UNSUPPORTED_CHANGE_TYPE:type-changed`。
- `Upper.PHP` 這類大寫副檔名與 `*.blade.php` 都會送進 analyzer。Blade 指令與 HTML 對 PHP parser 來說都是 inline HTML，沒有對應的 fact，因此 template 內容的變更是 `FULL`（`COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`）。

第 9 步（TypeScript / JavaScript 見本節最後）：

- PHP analyzer 以 AST 比較兩個版本：兩側都能以最新 PHP 語法解析時使用最新語法，否則兩側一起改用 PHP 7.4 語法。每個被解釋的差異都對應一個 fact（`CALL_REMOVED`、`BINARY_OPERATOR_CHANGED` 等，完整清單見 [README「已實作」](../README.md#已實作)）。
- 每個 fact 交給 deterministic domain interpreters（`src/interpreters/`：語言層 `core.js`、框架 preset `presets/php-laravel.js` / `presets/node.js`、業務 preset `presets/payments.js`；PHP 預設啟用 `php-laravel` 與 `payments`，TypeScript / JavaScript 預設啟用 `node`）：有對應規則的 fact 產生具體的原因代碼，沒有的產生 `FACT_UNHANDLED:<fact id>`。
- 結果：
  - 沒有任何 fact、兩個版本在 AST 比較下等價（排版、註解、區域變數一致改名等），而且 PHP 8 與 PHP 7 的解讀一致（不檢查 PHP 5 的語意，見「限制」）：`NOT_SELECTED_FOR_HUMAN_REVIEW`，原因 `NO_REDUCTION_BLOCKER`。
  - 每個差異都有 fact 解釋：`TARGETED`，原因是 fact 產生的代碼。
  - 有差異無法解釋，或分析無法完成：`FULL`，原因含 `COV-PHP-001:<原因>`；已找到的 fact 的原因也一起列出。
- rename 或檔案權限改變（例如 `100644` → `100755`）會再加上 `FILE_RENAMED` / `FILE_MODE_CHANGED`，因為 autoload 路徑或執行權限可能改變行為：
  - 內容等價（原本會是 `NOT_SELECTED_FOR_HUMAN_REVIEW`）時改為 `TARGETED`，原因只有 `FILE_RENAMED` / `FILE_MODE_CHANGED`。
  - 內容也有變更時，接在 analyzer 的原因之後，`TARGETED` / `FULL` 不變。

TypeScript / JavaScript：analyzer（`analyzers/ts`，TypeScript compiler API）與 PHP 相同，比較兩個版本的 AST 並以 fact 解釋差異：

- 等價（排版、一般註解、引號、分號、trailing comma、多餘括號、property key 是否加引號、數字寫法、JSX 依渲染空白規則的換行，以及 function 內一致的區域變數改名）：`NOT_SELECTED_FOR_HUMAN_REVIEW`。
- 每個差異都有 fact 解釋：`TARGETED`。fact 與 PHP 相同（`CALL_REMOVED`、`CALL_ARGUMENT_REMOVED`、`BINARY_OPERATOR_CHANGED`、`GUARD_REMOVED`、`LITERAL_CHANGED` 等），另有 decorator 的 `ANNOTATION_REMOVED` / `ANNOTATION_ADDED` 與指示註解的 `DIRECTIVE_COMMENT_CHANGED`（`@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`、`eslint-disable`、`#__PURE__`、webpack / vite 指示、coverage ignore、JSX pragma、triple-slash 指示、shebang 的增減或移動）。`node` preset 與 `.reviewer.json` 的規則比對這些 fact（見下方「Domain 原因代碼」）。
- 有差異無法解釋：`FULL`，原因含 `COV-TS-001:<原因>`；已找到的 fact 的原因也一起列出。
- 不視為等價、也不以 fact 解釋的情況（寧可要求 review）：型別註記、`as` 轉型、`interface` / `type` 的變更；參數與頂層變數改名；物件簡寫 `{ x }` 或解構 `const { x } = o` 中的變數改名（會改變 key）；會被賦予匿名 function / class / arrow 的變數改名（`fn.name` 會改變）；`function` 與箭頭函式互換；import 順序；`'a'` 與 `` `a` `` 互換；optional chain 外的括號（`(a?.b).c`）。檔案中有 direct `eval(...)` 或 `with` 時不做區域變數改名正規化。

## 決策語意

### 檔案層級

| `decision` | `fallback` | 意義 |
|---|---|---|
| `NOT_SELECTED_FOR_HUMAN_REVIEW` | `null` | analyzer 完整分析，兩個版本等價（沒有任何 fact），也不是 rename 或權限變更。不選入 Human Review |
| `HUMAN_REVIEW_REQUIRED` | `TARGETED` | 檔案中的**每個**變更都已被具體的 fact 解釋（或內容等價、只有 rename / 權限改變）。原因與位置說明變了什麼、從哪裡開始看；**仍需 review 整個檔案** |
| `HUMAN_REVIEW_REQUIRED` | `FULL` | 至少有一個變更無法被解釋，或檔案沒有（或無法）分析。需完整 review 該檔案 |

- `TARGETED` 與 `FULL` 的差別是 Reviewer 是否已經知道每個變更是什麼，而不是要看的範圍大小。兩者都要 review 整個檔案。
- 原因只有 `FACT_UNHANDLED:*` 的檔案仍是 `TARGETED`：變更已被 fact 解釋，只是沒有對應的 domain 規則。
- `NOT_SELECTED_FOR_HUMAN_REVIEW` 不是「程式一定沒問題」，而是在目前可驗證的證據下，這個檔案的兩個版本在 AST 比較下等價。

### PR 層級

報表的 `decision` 彙整所有檔案：

- `status`：**所有**檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`；任何一個檔案需要 review 就是 `HUMAN_REVIEW_REQUIRED`。沒有任何檔案變更時是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- `reasons`：需要 review 的檔案的原因，去重後依字母排序（`FACT_UNHANDLED:<id>` 逐一列出）。有檔案變更但都不需要 review 時為 `[]`；沒有任何檔案變更時為 `["NO_CHANGES"]`。
- `files` / `notSelected` / `targeted` / `full`：檔案數。`targeted + full` 是需要 review 的檔案數。

### 路由（三層審查）

核心流程是串接的：**機械審查（本 CLI）→ AI 審查剩下的 → AI 審查後需要人處理、確認的才交給人工**。`decision` 之外，每個檔案另有路由 `track`（`src/routing.js`），標示機械審查之後的去向。路由不改變 `decision`，也不會讓需要 review 的檔案變成不需要。

| `track` | 條件 | 去向 |
|---|---|---|
| `AUTO_PASS` | `decision` 為 `NOT_SELECTED_FOR_HUMAN_REVIEW` | 不需要 review |
| `AI_TRACK` | 需要 review，但沒有任何原因屬於單向門。包括 `FULL`（無法解釋的變更、analyzer 失敗、沒有分析的檔案） | 交給 AI 審查，由 AI 判斷是否需要人工 |
| `ESCALATED` | 任一原因屬於單向門；或 `decision` 不是這兩種已知的值 | 一樣先交給 AI 審查，但 AI 不能放行，之後一律交給人工確認 |

AI 審查層尚未實作（見 [三層審查架構設計](superpowers/specs/2026-10-18-three-tier-review-design.md) §6）。

單向門（做了就難以回頭的變更）的預設清單：`TRANSACTION_BOUNDARY_REMOVED`、`TRANSACTION_ROLLBACK_REMOVED`、`ROW_LOCK_REMOVED`、`AUTHORIZATION_GUARD_REMOVED`、`AUTHORIZATION_ABILITY_CHANGED`、`MIDDLEWARE_GUARD_REMOVED`、`SIGNATURE_VERIFICATION_REMOVED`、`GUARD_CLAUSE_REMOVED`、`PROTECTED_CALL_REMOVED`、`PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED`、`PROTECTED_ARGUMENT_CHANGED`、`SENSITIVE_OPERAND_CHANGED`、`MASS_ASSIGNMENT_CHANGED`、`SERIALIZED_ATTRIBUTES_CHANGED`、`SIDE_EFFECT_CALL_ADDED`、`DATA_DELETION_ADDED`、`PROTECTED_PATH`、`POLICY_FILE_CHANGED`、`POLICY_CONFIG_INVALID`。其中幾個代碼由專案設定的規則產生（見 [專案設定](project-config.md)）。

PR 層級的 `routing.track` 取所有檔案中最嚴格的一個（`ESCALATED` > `AI_TRACK` > `AUTO_PASS`）；沒有任何檔案變更時為 `AUTO_PASS`。

## 原因代碼

### 未送進 analyzer 的檔案（一律 `FULL`）

| 代碼 | 意義 |
|---|---|
| `FILE_ADDED` | 新增的 PHP 檔 |
| `FILE_DELETED` | 刪除的 PHP 檔 |
| `UNSUPPORTED_FILE_TYPE` | 非 PHP 檔（任何變更，包括新增、刪除與 rename） |
| `BINARY_FILE` | PHP 檔的任一側內容含 NUL byte |
| `SYMLINK_CHANGED` | symlink 新增、刪除或改指向 |
| `SUBMODULE_CHANGED` | submodule 新增、刪除或改指向的 commit |
| `UNSUPPORTED_CHANGE_TYPE:<status>` | git 狀態不是新增、刪除、修改或 rename。實際會出現的是 `type-changed`；`copied` 不會出現，因為 `git diff` 只開 rename 偵測（`-M`），不開 copy 偵測 |

### 專案設定（[`.reviewer.json`](project-config.md)）

| 代碼 | 意義 |
|---|---|
| `POLICY_CONFIG_INVALID` | merge base 的 `.reviewer.json` 無效。每個檔案都是 `FULL`，錯誤細節見 JSON 報表的 `config.errors` |
| `POLICY_FILE_CHANGED` | PR 修改了 `.reviewer.json` 或 `codingstandards.md`（單向門） |
| `PROTECTED_PATH` | 檔案符合 `rules.protectedPaths`（單向門）。原本不需要 review 的檔案變成 `TARGETED` |
| `SENSITIVE_OPERAND_CHANGED` / `PROTECTED_CALL_REMOVED` / `PROTECTED_ARGUMENT_CHANGED` / `SIDE_EFFECT_CALL_ADDED` | 專案規則命中（單向門），見 [專案設定](project-config.md) |

### `ANALYZER_ERROR:<訊息>`（`FULL`）

analyzer process 沒有正常產生結果。訊息最多 200 字元：

| 訊息 | 原因 |
|---|---|
| `PHP_ANALYZER_ABORTED` | 超過 `--timeout-ms`，analyzer 被終止 |
| `spawn php ENOENT` | PATH 上找不到 `php` |
| `PHP_ANALYZER_EXIT_<code>:<stderr>` | analyzer 以非 0 結束，例如 `php` 低於 8.3（PHP 8.0–8.2 為已安裝的依賴被 Composer 的 platform check 擋下，沒有安裝依賴時則是 `COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING`；PHP 7 以下為 analyzer 本身用到 PHP 8.0 的語法而無法解析） |
| `PHP_ANALYZER_OUTPUT_INVALID` | analyzer 的 stdout 不是 JSON |

### `COV-PHP-001:<原因>`（`FULL`）

`COV-PHP-001` 是 PHP analyzer 的 coverage obligation。analyzer 無法完整解釋變更時以 `COV-PHP-001:<原因>` 回報：

| 原因 | 意義 |
|---|---|
| `UNRECOGNIZED_PHP_CHANGE` | 有 AST 差異無法對應到任何 fact。已找到的 fact 與其原因仍會列出 |
| `PHP_GRAMMAR_DIVERGENCE` | 在主要語法下判為等價，但 PHP 8 與 PHP 7（7.4 語法，`#[` 視為註解）的解讀不同：兩側在某個語法下的可解析性不一致，或在該語法下不等價。例如把 `$a . $b + $c` 改成 `$a . ($b + $c)`（`.` 與 `+` 的優先順序在 PHP 8 改變） |
| `PHP_PARSE_ERROR` | 最新語法與 PHP 7.4 語法都無法同時解析兩個版本，例如有語法錯誤 |
| `PHP_FILE_DELETION_UNSUPPORTED` | head 版本是空檔（檔案被清空但沒有刪除） |
| `PHP_ANALYZER_DEPENDENCY_MISSING` | `analyzers/php/vendor` 不存在；先執行 `npm run analyzer:install`（需要 PHP 8.3 以上，否則安裝會因 platform requirement 失敗） |

### `COV-TS-001:<原因>`（`FULL`）

`COV-TS-001` 是 TypeScript / JavaScript analyzer 的 coverage obligation：

| 原因 | 意義 |
|---|---|
| `UNRECOGNIZED_TS_CHANGE` | 有差異無法以 fact 解釋（例如型別註記、`as` 轉型、property key 改變、運算子優先順序、`function` 與箭頭函式互換、modifier 增減） |
| `TS_PARSE_ERROR` | 任一側有語法錯誤（包含 TypeScript parser 回報的文法錯誤） |
| `TS_FILE_DELETION_UNSUPPORTED` | head 版本是空檔 |
| `TS_ANALYZER_DEPENDENCY_MISSING` | `analyzers/ts/node_modules` 沒有 `typescript`；先執行 `npm run analyzer:install` |

### `FILE_RENAMED` / `FILE_MODE_CHANGED`

| 代碼 | 意義 |
|---|---|
| `FILE_RENAMED` | 檔案改名或搬移（autoload / import 路徑可能改變） |
| `FILE_MODE_CHANGED` | 檔案的權限改變（例如加上執行權限） |

內容等價時檔案為 `TARGETED`，否則接在 analyzer 的原因之後（見「檔案分類」）。不支援的檔案的 rename 或權限變更只會是 `UNSUPPORTED_FILE_TYPE`。

### `FACT_UNHANDLED:<fact id>`

fact 沒有任何 domain interpreter 對應。fact id 的格式是 `php-` 或 `ts-` 加 20 個十六進位字元。與 domain 原因代碼相同，檔案沒有 `COV-PHP-001:*` / `COV-TS-001:*` 時為 `TARGETED`（變更已被 fact 解釋，只是沒有對應的 domain 規則）；有的話為 `FULL`，已找到的 fact 照樣列出。

例外：位置參數的變更無法被更細的 fact 解釋時，analyzer 仍輸出 `CALL_ARGUMENT_CHANGED` 標示位置（描述為「`<callee>` 的參數 #<index>：<原值> → <新值>」），但這個 fact 不視為已解釋，所以同一檔案也會有 `COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`，為 `FULL`。例如 `$q->take(10)` 改成 `$q->take($n)`：原因是 `COV-PHP-001:UNRECOGNIZED_PHP_CHANGE` 與這個 fact 的 `FACT_UNHANDLED:<id>`。

- 參數純移除或純新增（`CALL_ARGUMENT_REMOVED` / `CALL_ARGUMENT_ADDED`，描述為「`<callee>` 移除參數 <位置或名稱>：<值>」）是已解釋的變更：沒有對應的 domain 規則時是 `TARGETED` 的 `FACT_UNHANDLED`。
- 例如 `CALL_ADDED`（新增呼叫）只有資料刪除（`DATA_DELETION_ADDED`）與專案設定的 `sideEffectCalls` 會處理，其餘是 `FACT_UNHANDLED`；其他 fact 只有符合下一節的模式時才有具體代碼。
- 文字輸出把它們合併成一行 `FACT_UNHANDLED ×N`；JSON 逐一列出。
- JSON 的 `facts` 不含 fact id，無法以 id 對應到個別 fact；請以 fact 的 `kind` 與位置判斷。

### Domain 原因代碼

由 `src/interpreters/`（語言層 `core.js`、框架 preset `presets/php-laravel.js` / `presets/node.js`、業務 preset `presets/payments.js`） 產生。檔案沒有 `COV-PHP-001:*` / `COV-TS-001:*` 時為 `TARGETED`。下表的「意義」欄是 PHP / Laravel 的規則；TypeScript / JavaScript 的 `node` preset 產生相同的代碼，範圍見表後。同一個 fact 可能產生多個代碼，例如 `rules()` 的回傳值改變同時產生 `RETURN_VALUE_CHANGED` 與 `VALIDATION_RULE_CHANGED`。

| 代碼 | 來源 fact | 意義 |
|---|---|---|
| `PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED` | `CALL_ARGUMENT_CHANGED` | named argument `idempotencyKey` 的值改變 |
| `TRANSACTION_BOUNDARY_REMOVED` | `CALL_REMOVED` | 移除 `beginTransaction`（任何 receiver），或移除 DB 連線 receiver 的 `transaction` / `commit`。DB 連線 receiver 指最後一段為 `DB`、以 `db` 或 `connection` 結尾（不分大小寫）或 `pdo`，例如 `DB::`、`$db->`、`$this->adminDB->` |
| `TRANSACTION_ROLLBACK_REMOVED` | `CALL_REMOVED` | 移除 DB 連線 receiver 的 `rollBack` / `rollback` |
| `AUTHORIZATION_GUARD_REMOVED` | `CALL_REMOVED` | 移除 `$this->authorize`、`$this->authorizeForUser` 或 `Gate::authorize` |
| `AUTHORIZATION_ABILITY_CHANGED` | `LITERAL_CHANGED` | `$this->authorize` 或 `Gate::authorize` 的第一個參數（ability）從字面值換成另一個字面值，例如 `'update'` → `'view'`。`$this->authorizeForUser` 的 ability 是第二個參數，換成另一個字面值時為 `FACT_UNHANDLED`。任一呼叫的 ability 改成變數等非字面值（例如 `'update'` → `$ability`）時無法解釋，檔案為 `FULL`（`COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`） |
| `MIDDLEWARE_GUARD_REMOVED` | `CALL_REMOVED`、`CALL_ARGUMENT_CHANGED`、`CALL_ARGUMENT_REMOVED`、`ARRAY_ITEM_REMOVED`、`LITERAL_CHANGED` | 原本的 middleware 不再套用：`->middleware(...)` 呼叫或其中一個參數被移除、`Route::group` 含 `'middleware'` 的設定參數被移除，或 `->middleware(...)`、`Route::group` 的 `'middleware'`、`$middleware` / `$middlewares` / `$beforeActionList` property 少了某個 middleware、名稱被換掉 |
| `ROW_LOCK_REMOVED` | `CALL_REMOVED` | 移除 `lockForUpdate` / `sharedLock` |
| `SIGNATURE_VERIFICATION_REMOVED` | `CALL_REMOVED` | 移除名稱像簽章驗證的 method，例如 `verifySign`、`verificationSign`、`checkSign`、`validateSignature` |
| `COMPARISON_OPERATOR_CHANGED` | `BINARY_OPERATOR_CHANGED` | 比較運算子互換（`<`、`<=`、`>`、`>=`、`==`、`!=`、`===`、`!==`、`<>`、`<=>`） |
| `ARITHMETIC_OPERATOR_CHANGED` | `BINARY_OPERATOR_CHANGED` | 算術運算子互換（`+`、`-`、`*`、`/`、`%`、`**`） |
| `LOGICAL_OPERATOR_CHANGED` | `BINARY_OPERATOR_CHANGED` | 邏輯運算子互換（`&&`、`\|\|`、`and`、`or`、`xor`） |
| `OPERATOR_CHANGED` | `BINARY_OPERATOR_CHANGED` | 其他運算子改變，或前後不屬於同一類 |
| `GUARD_CLAUSE_REMOVED` | `GUARD_REMOVED` | 移除 guard clause（沒有 else / elseif、body 只有一個 throw / return / exit 的 if）。有 else / elseif 的 if 整段移除時無法解釋，檔案為 `FULL`（`COV-PHP-001:UNRECOGNIZED_PHP_CHANGE`） |
| `GUARD_CLAUSE_ADDED` | `GUARD_ADDED` | 新增 guard clause（定義同上） |
| `CONDITION_NEGATED` | `EXPRESSION_NEGATED` | `if` / `elseif`、`while` / `do-while`、`for`、三元運算、`match`（含 arm 條件）的條件被反轉（`X` ↔ `!X`） |
| `BOOLEAN_VALUE_NEGATED` | `EXPRESSION_NEGATED` | 條件以外的運算式被反轉，例如回傳值 |
| `RETURN_VALUE_CHANGED` | `RETURN_VALUE_CHANGED` | 回傳值換成常數或從常數換掉（`return null;`、`return [];`、`return;` 等） |
| `ARGUMENTS_REORDERED` | `CALL_ARGUMENTS_REORDERED` | 參數內容相同、只有順序改變 |
| `PARAMETER_RENAMED` | `VARIABLE_CHANGED` | 參數改名（會改變 named argument 的 API） |
| `VARIABLE_REFERENCE_CHANGED` | `VARIABLE_CHANGED` | 改用另一個變數（資料流改變） |
| `CONSTANT_VALUE_CHANGED` | `LITERAL_CHANGED` | `const` 宣告的值改變 |
| `VALIDATION_RULE_CHANGED` | `LITERAL_CHANGED`、`ARRAY_ITEM_*`、`RETURN_VALUE_CHANGED` | Laravel validation 規則增減或改值：`rules()` 的回傳值、`$this->validate` / `$request->validate`（含 `validateWithBag`）、`Validator::make` 的第二個參數 |
| `MASS_ASSIGNMENT_CHANGED` | 同上 | model 的 `$fillable` / `$guarded` 改變 |
| `SERIALIZED_ATTRIBUTES_CHANGED` | 同上 | model 的 `$hidden` / `$visible` 改變 |
| `ATTRIBUTE_CAST_CHANGED` | 同上 | model 的 `$casts` 或 `casts()` 的回傳值改變 |
| `DATA_DELETION_ADDED` | `CALL_ADDED` | 新增刪除資料或 schema 的呼叫：`forceDelete`、`truncate`、`dropColumn`、`Schema::drop` / `dropIfExists`、`Storage::delete` / `File::delete`、`DB::delete`、`unlink`。一般的 `->delete()` 可能是 soft delete，不列入 |
| `ANNOTATION_REMOVED` / `ANNOTATION_ADDED` | 同名 fact | decorator 被移除 / 新增（目前只有 TS analyzer 輸出） |
| `DIRECTIVE_COMMENT_CHANGED` | 同名 fact | 有語意的註解被新增、移除或移動（目前只有 TS analyzer 輸出） |

TypeScript / JavaScript 的 `node` preset（`src/interpreters/presets/node.js`）：

| 代碼 | 範圍 |
|---|---|
| `TRANSACTION_BOUNDARY_REMOVED` | 移除 `prisma.$transaction`、`startTransaction` / `beginTransaction` / `commitTransaction` / `withTransaction`、DB 或 ORM receiver（`prisma`、`db`、`knex`、`sequelize`、`dataSource`、`manager`、`queryRunner`…）的 `transaction`、transaction 物件（`t`、`tx`、`trx`…）的 `commit`、knex `.transacting()`、`@Transactional()`；移除 Sequelize `{ transaction: t }` 或 Mongoose `{ session }` 選項。Sentry 等 tracing 的 transaction 不算 |
| `TRANSACTION_ROLLBACK_REMOVED` | 移除 `rollbackTransaction` / `abortTransaction`，或 DB / transaction 物件的 `rollback` |
| `ROW_LOCK_REMOVED` | 移除 knex `.forUpdate()` / `.forShare()` / `.forNoKeyUpdate()` / `.forKeyShare()`、TypeORM `.setLock()`，或選項物件中的 `lock` / `lockMode`（`where: { lock: 1 }` 這種巢狀 key 不算） |
| `AUTHORIZATION_GUARD_REMOVED` | 移除 `@UseGuards` / `@Roles` / `@Permissions` / `@Auth` 等授權 decorator、`@UseGuards` 少了 guard 或換掉、加上 `@Public()` / `@AllowAnonymous()` / `@SkipAuth()` 等、移除 `authorize` / `throwUnlessCan` 等授權呼叫或 `app.useGlobalGuards` |
| `AUTHORIZATION_ABILITY_CHANGED` | `@Roles` / `@Permissions` / `@Scopes` 等的參數改變、增加或減少 |
| `MIDDLEWARE_GUARD_REMOVED` | app / router（`app`、`server`、`router`、`fastify`、`*Router`、`*App`）的路由註冊（`get`、`post`、`use`…）少了路徑以外的參數、參數換成另一個 middleware、middleware 陣列少了元素；`app.use` / `addHook`、Nest `consumer.apply`、`passport.authenticate` 被移除；Fastify 路由選項的 `onRequest` / `preParsing` / `preValidation` / `preHandler` 被移除或少了元素。`axios.post`、`api.post` 等不是路由註冊 |
| `SIGNATURE_VERIFICATION_REMOVED` | 移除 `jwtVerify`、`timingSafeEqual`、`constructEvent`、`verifyIdToken`，jwt / jose / crypto / token / verifier 等 receiver 的 `verify` / `verifyAsync`，或名稱像簽章驗證的 method |
| `VALIDATION_RULE_CHANGED` | zod / joi / yup 的 schema（`z.object(...)` 的參數、`.min()` / `.optional()` 等規則 method 的增減與參數）、class-validator decorator（`@IsInt`、`@Min`…）、`new ValidationPipe(...)`、移除 `@UsePipes` / `useGlobalPipes` / `safeParse` / `validateOrReject` / schema 的 `parse`、Fastify 路由的 `schema` 選項 |
| `DATA_DELETION_ADDED` | 新增 `deleteMany`、`dropTable` / `dropColumn`、`findByIdAndDelete`、S3 `deleteObject`、knex `.del()` / `.truncate()`、DB / repository / model receiver 上的 `delete` / `deleteOne` / `remove` / `destroy` / `clear`、Sequelize `User.destroy`、`fs.rm` / `unlink` / `rmdir` / `rimraf`。`map.delete`、`socket.destroy`、`cacheManager.del` 不算 |

名稱判斷是啟發式的：receiver 名稱不在上述範圍（例如把 router 命名為 `r`）時不會命中，fact 仍會以 `FACT_UNHANDLED` 交給 AI 審查。請以 `.reviewer.json` 的 `protectedCalls` 等規則補上專案自己的命名。

### 其他

| 代碼 | 意義 |
|---|---|
| `NO_REDUCTION_BLOCKER` | `NOT_SELECTED_FOR_HUMAN_REVIEW` 檔案的原因（只出現在 JSON） |
| `NO_CHANGES` | PR 層級：merge base 到 head 沒有任何檔案變更（只出現在 JSON；文字輸出顯示「沒有任何檔案變更。」） |

`ADAPTER_*`、`ANALYZER_FACT_INTERPRETER_*`、`COV-PHP-001:PHP_ANALYZER_INPUT_INVALID` 等是 pipeline 的防禦性檢查，正常執行不會出現；出現時檔案為 `FULL`。

## 文字輸出

沒有 `--json` 時，stdout 是給人看的報表（`src/review/format.js`）：

```
Review：<PR 決策>（<需要 review 的檔案數>/<檔案數> 個檔案需要 review；TARGETED <n>、FULL <n>）
路由：<PR 路由>（交給 AI 審查 <n>，其中 <n> 個 AI 審查後必須人工確認；不需要 review <n>）
<repository>  <base ref> (<base SHA 前 12 碼>) → <head ref> (<head SHA 前 12 碼>)[，比較起點為 merge base <SHA 前 12 碼>]

AI 審查後必須人工確認（ESCALATED，單向門）：
  <FULL|TARGETED> <path>[（原 <oldPath>）]
           - <原因代碼>[（說明）]
           - FACT_UNHANDLED ×<N>（有變更但沒有對應的 domain 規則，請看標示位置）
           變更位置：<side>:L<start>[-<end>]、…[ 等 <N> 處]
           · <side>:L<start>[-<end>] <fact 描述>
           · …另有 <N> 項（見 --json）

交給 AI 審查，由 AI 判斷是否需要人工（AI_TRACK）：
  （格式同上）

不需要 review（<N>）：
  <path>
```

- 需要 review 的檔案依路由分成「AI 審查後必須人工確認」與「交給 AI 審查，由 AI 判斷是否需要人工」兩段（沒有檔案的段落不印）。每一段先列 `FULL` 再列 `TARGETED`，同一組依路徑排序；不需要 review 的檔案依 `git diff` 的順序。
- `-` 行：每個原因一行。單向門標示「（單向門）」；部分代碼附中文說明（`format.js` 的 `REASON_HINTS`），其餘只顯示代碼。`FACT_UNHANDLED:<id>` 不逐一列出，合併成 `FACT_UNHANDLED ×N` 一行。不需要 review 的檔案不顯示原因。
- 「變更位置」：`git diff -U0` 的 hunk。有新內容的 hunk 標 head 版本的行號；純刪除的 hunk 標 merge base 版本被刪除的行（`base:`）。只有修改與 rename 的檔案有這一行；最多列 8 處，超過時加上「等 N 處」。
- `·` 行：analyzer 找到的 fact。`base:` 表示位置在 merge base 版本（通常是被移除的程式碼），`head:` 表示在 head 版本。最多列 8 項，其餘見 `--json`。`FULL` 的檔案也可能有 fact 行（已解釋的部分）。
- 沒有任何檔案變更時，只印前三行與「沒有任何檔案變更。」。

範例（`feature` 分支從 `main` 分出後，`main` 又多了一個修改 `README.md` 的 commit；這個變更不屬於 PR，所以不在清單中）：

```
Review：HUMAN_REVIEW_REQUIRED（5/6 個檔案需要 review；TARGETED 3、FULL 2）
路由：ESCALATED（交給 AI 審查 5，其中 1 個 AI 審查後必須人工確認；不需要 review 1）
shop  main (48016bdb0fe7) → feature (594959a22beb)，比較起點為 merge base ec4021f968a4

AI 審查後必須人工確認（ESCALATED，單向門）：
  TARGETED app/Http/Controllers/PostController.php
           - AUTHORIZATION_GUARD_REMOVED（單向門）
           變更位置：base:L9-10
           · base:L9 移除呼叫 $this->authorize

交給 AI 審查，由 AI 判斷是否需要人工（AI_TRACK）：
  FULL     app/Services/ReportService.php
           - COV-PHP-001:UNRECOGNIZED_PHP_CHANGE（有無法自動解釋的變更，請看整個檔案）
           變更位置：head:L9-14
  FULL     composer.json
           - UNSUPPORTED_FILE_TYPE（不支援的檔案類型，未分析）
           變更位置：head:L3
  TARGETED app/Services/FreezeService.php
           - COMPARISON_OPERATOR_CHANGED
           變更位置：head:L9
           · head:L9 運算子 < → <=：$cash->amount < $amount → $cash->amount <= $amount
  TARGETED app/Services/RefundService.php
           - FACT_UNHANDLED ×1（有變更但沒有對應的 domain 規則，請看標示位置）
           變更位置：head:L10
           · head:L10 新增呼叫 $order->notify

不需要 review（1）：
  app/Services/LegacyHelper.php
```

`LegacyHelper.php` 只有排版與註解變更，所以不需要 review。`PostController.php` 移除了 `authorize`（單向門），AI 審查後必須人工確認。其餘需要 review 的檔案（包括機械審查無法解釋的 `ReportService.php` 與沒有分析的 `composer.json`）交給 AI 審查，由 AI 判斷是否需要人工。`FreezeService.php` 的運算子改變沒有命中單向門；若專案設定把 `amount` 列為敏感運算元（[專案設定](project-config.md)），它會變成 `SENSITIVE_OPERAND_CHANGED` 而需要人工確認。超過 8 處時的截斷：

```
  TARGETED Many.php
           - FACT_UNHANDLED ×10（有變更但沒有對應的 domain 規則，請看標示位置）
           變更位置：head:L4、head:L7、head:L10、head:L13、head:L16、head:L19、head:L22、head:L25 等 10 處
           · head:L4 新增呼叫 $s->audit1
           · head:L7 新增呼叫 $s->audit2
           · head:L10 新增呼叫 $s->audit3
           · head:L13 新增呼叫 $s->audit4
           · head:L16 新增呼叫 $s->audit5
           · head:L19 新增呼叫 $s->audit6
           · head:L22 新增呼叫 $s->audit7
           · head:L25 新增呼叫 $s->audit8
           · …另有 2 項（見 --json）
```

## JSON 報表

`--json` 的 stdout 與 `--out` 寫入的檔案內容相同。報表沒有 `schemaVersion`，欄位可能隨版本改變；它也不是 [docs/integrations/agent-work-harness.md](integrations/agent-work-harness.md) 中提案的 `reviewer plan` 格式。

### 頂層

| 欄位 | 型別 | 說明 |
|---|---|---|
| `repository` | string | repository 根目錄（`git rev-parse --show-toplevel`）的目錄名稱，不是 `owner/repo` |
| `base.ref` | string | `--base` 的原始值 |
| `base.sha` | string | `--base` 指向的 commit（40 字元 SHA） |
| `head.ref` | string | `--head` 的原始值 |
| `head.sha` | string | `--head` 指向的 commit |
| `mergeBase` | string | `git merge-base <base> <head>`，也就是比較起點 |
| `decision.status` | string | PR 層級決策：`NOT_SELECTED_FOR_HUMAN_REVIEW` 或 `HUMAN_REVIEW_REQUIRED` |
| `decision.reasons` | string[] | 需要 review 的檔案的原因，去重後排序；都不需要 review 時為 `[]`；沒有任何檔案變更時為 `["NO_CHANGES"]` |
| `decision.files` | number | 變更的檔案數 |
| `decision.notSelected` | number | 不需要 review 的檔案數 |
| `decision.targeted` | number | `TARGETED` 的檔案數 |
| `decision.full` | number | `FULL` 的檔案數 |
| `config.path` / `config.commit` | string | 專案設定的路徑（`.reviewer.json`）與讀取的 commit（merge base） |
| `config.status` | string | `absent`（沒有設定，使用預設值）、`valid` 或 `invalid`（每個檔案都是 `FULL` + `POLICY_CONFIG_INVALID`） |
| `config.errors` | string[] | 設定無效的原因，例如 `POLICY_CONFIG_KEY_UNKNOWN:rules.ignoreFacts`；其他狀態為 `[]` |
| `config.digest` | string \| null | 有效設定內容的 sha256；其他狀態為 `null` |
| `routing.track` | string | PR 層級路由：`AUTO_PASS`、`AI_TRACK` 或 `ESCALATED`（見「路由」） |
| `routing.autoPass` / `routing.aiTrack` / `routing.escalated` | number | 各路由的檔案數 |
| `files` | object[] | 每個變更檔案的結果，順序與 `git diff --raw` 相同 |

### `files[]`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `path` | string | head 的路徑；刪除的檔案為原路徑 |
| `oldPath` | string | 原路徑，只有 rename 才有這個欄位 |
| `status` | string | `added`、`deleted`、`modified`、`renamed`、`type-changed`（其他 git 狀態字母原樣輸出） |
| `contentHash` | string | head 版本內容的識別：`git:<blob id>`；刪除的檔案為 `deleted:<base 的 blob id>`。檔案層級的人工豁免綁定在這個值上 |
| `analyzed` | boolean | 是否經過 analyzer 的分析流程（「檔案分類」第 9 步）。結果是 `COV-PHP-001:*` / `COV-TS-001:*` 時也是 `true`；第 1–8 步的檔案（含 `ANALYZER_ERROR`）為 `false` |
| `decision` | string | `NOT_SELECTED_FOR_HUMAN_REVIEW` 或 `HUMAN_REVIEW_REQUIRED` |
| `fallback` | string \| null | `TARGETED`、`FULL`；不需要 review 時為 `null` |
| `reasons` | string[] | 原因代碼。analyzer 的原因依字母排序，`FILE_RENAMED` / `FILE_MODE_CHANGED` 接在最後。代碼可能帶參數，例如 `UNSUPPORTED_CHANGE_TYPE:type-changed`、`ANALYZER_ERROR:<訊息>`、`FACT_UNHANDLED:<fact id>` |
| `track` | string | 路由：`AUTO_PASS`、`AI_TRACK` 或 `ESCALATED` |
| `oneWayDoors` | string[] | `reasons` 中屬於單向門的原因；沒有時為 `[]` |
| `facts` | object[] | analyzer 找到的所有 fact；未分析的檔案為 `[]` |
| `facts[].kind` | string | fact 種類，例如 `CALL_REMOVED` |
| `facts[].subject` | string | 所屬的 `Class::method` 或 function；不在 method / function 內時為檔案路徑 |
| `facts[].side` | string | `base`（merge base 版本）或 `head` |
| `facts[].startLine` / `endLine` | number | 該版本中的行號（從 1 起算） |
| `facts[].description` | string | 中文描述，與文字輸出的 `·` 行相同 |
| `facts[].blockers` | string[] | 這個 fact 自己產生的原因代碼（`reasons` 是整個檔案的彙總）；沒有 domain 規則時為 `FACT_UNHANDLED:<fact id>` |
| `facts[].anchor` | object | fact 中不隨位置改變的內容（例如移除的 callee 的名稱與 receiver），用於 finding id |
| `facts[].scopeHash` | string \| null | head 版本中所屬 method / function 的 canonical AST hash（`php:<hash>`）；排版、註解與一致的區域變數改名不會改變它。不在 method / function 內、或 head 中已沒有該 method 時為整個檔案的 canonical hash；沒有輸出 scope 的 analyzer 為 `null` |
| `findings` | object[] | 需要人工處理的項目（只有 `track` 為 `ESCALATED` 的檔案才有，其他為 `[]`），見「Findings」 |
| `changedLines` | object[] | 只有 `decision` 為 `HUMAN_REVIEW_REQUIRED` 的檔案才有這個欄位。`git diff -U0` 的 hunk：`{ side, startLine, endLine }`，有新內容的 hunk 為 `head` 的行號，純刪除的 hunk 為 `base` 的行號。修改與 rename 以外的檔案（新增、刪除、`type-changed`）為 `[]`；沒有文字 hunk 的變更（binary、只改權限、內容不變的 rename）也是 `[]` |

### Findings

`files[].findings` 是必須人工確認的項目，也是二次 review 的追蹤單位（`src/findings.js`），之後的 GitHub 整合以它記錄「看過了」或「修好了」。目前只有機械審查的單向門（AI 審查層加入的「需要人工」項目尚未實作）：

- 每個帶單向門原因的 fact，每個原因一個 finding（`kind` 為 fact 種類）；
- 檔案層級的單向門原因（`PROTECTED_PATH`、`POLICY_FILE_CHANGED`、`POLICY_CONFIG_INVALID`）各一個（`kind: "FILE"`）。

`FULL` 本身不是人工項目：無法解釋的部分交給 AI 審查。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | `sha256(path, subject, kind, blocker, anchor, ordinal)`。不含行號，在上方插入程式碼或排版不會改變；fact 消失（例如加回被移除的 `authorize`）時這個 id 也不再出現 |
| `path` / `subject` / `kind` / `blocker` / `anchor` | | 組成 id 的內容；檔案層級的 finding 的 `subject` 為檔案路徑、`anchor` 為原因代碼 |
| `ordinal` | number | 同一個 subject 中 `kind`、`blocker`、`anchor` 都相同的 finding 依出現順序編號（從 0 起），避免兩件事被合併成一件 |
| `scopeHash` | string | 人工豁免要綁定的內容：fact 的 `scopeHash`，檔案層級或沒有 scope 時為 `contentHash`。豁免後這個值改變，就代表被看過的程式碼又改了 |
| `location` | object \| null | fact 的位置 `{ side, startLine, endLine }`；檔案層級為 `null` |
| `description` | string \| null | fact 的描述；檔案層級為 `null` |

TypeScript / JavaScript 的 finding 與 PHP 相同，由 fact 產生（`scopeHash` 為 `ts:` 開頭的所屬 function hash，或整個檔案的 hash）。

範例（上面 `shop` 的報表，`files` 只節錄 3 筆：AI 審查後必須人工確認的 `PostController.php`，以及交給 AI 審查的 `FreezeService.php` 與 `composer.json`）：

```json
{
  "repository": "shop",
  "base": {
    "ref": "main",
    "sha": "48016bdb0fe744a5f488219ea0152aae1bdd311b"
  },
  "head": {
    "ref": "feature",
    "sha": "594959a22bebcab30f99df672c7c27ba1c6f323e"
  },
  "mergeBase": "ec4021f968a437c1b9d942109f8723cade7dd0ac",
  "config": {
    "path": ".reviewer.json",
    "commit": "ec4021f968a437c1b9d942109f8723cade7dd0ac",
    "status": "absent",
    "errors": [],
    "digest": null
  },
  "decision": {
    "status": "HUMAN_REVIEW_REQUIRED",
    "reasons": [
      "AUTHORIZATION_GUARD_REMOVED",
      "COMPARISON_OPERATOR_CHANGED",
      "COV-PHP-001:UNRECOGNIZED_PHP_CHANGE",
      "FACT_UNHANDLED:php-51031e647c86e74cf9f7",
      "UNSUPPORTED_FILE_TYPE"
    ],
    "files": 6,
    "notSelected": 1,
    "targeted": 3,
    "full": 2
  },
  "routing": {
    "track": "ESCALATED",
    "autoPass": 1,
    "aiTrack": 4,
    "escalated": 1
  },
  "files": [
    {
      "path": "app/Http/Controllers/PostController.php",
      "status": "modified",
      "contentHash": "git:ded36e7b0ecee781a7072b9bb1b853c19bc84eca",
      "analyzed": true,
      "decision": "HUMAN_REVIEW_REQUIRED",
      "fallback": "TARGETED",
      "reasons": [
        "AUTHORIZATION_GUARD_REMOVED"
      ],
      "facts": [
        {
          "kind": "CALL_REMOVED",
          "subject": "PostController::update",
          "side": "base",
          "startLine": 9,
          "endLine": 9,
          "description": "移除呼叫 $this->authorize",
          "blockers": [
            "AUTHORIZATION_GUARD_REMOVED"
          ],
          "anchor": {
            "callee": {
              "name": "authorize",
              "receiver": [
                "this"
              ],
              "kind": "method"
            }
          },
          "scopeHash": "php:747b177afa33d6ce552e8ca3161f4121"
        }
      ],
      "changedLines": [
        {
          "side": "base",
          "startLine": 9,
          "endLine": 10
        }
      ],
      "track": "ESCALATED",
      "oneWayDoors": [
        "AUTHORIZATION_GUARD_REMOVED"
      ],
      "findings": [
        {
          "id": "d411be1b5801ad75a55b4e36073b03f2a62cb015571825fe3e8c7684bb5d4ba6",
          "path": "app/Http/Controllers/PostController.php",
          "subject": "PostController::update",
          "kind": "CALL_REMOVED",
          "blocker": "AUTHORIZATION_GUARD_REMOVED",
          "anchor": {
            "callee": {
              "name": "authorize",
              "receiver": [
                "this"
              ],
              "kind": "method"
            }
          },
          "scopeHash": "php:747b177afa33d6ce552e8ca3161f4121",
          "location": {
            "side": "base",
            "startLine": 9,
            "endLine": 9
          },
          "description": "移除呼叫 $this->authorize",
          "ordinal": 0
        }
      ]
    },
    {
      "path": "app/Services/FreezeService.php",
      "status": "modified",
      "contentHash": "git:5e58eb6d48972f8ddf199397b8add007d5c8396c",
      "analyzed": true,
      "decision": "HUMAN_REVIEW_REQUIRED",
      "fallback": "TARGETED",
      "reasons": [
        "COMPARISON_OPERATOR_CHANGED"
      ],
      "facts": [
        {
          "kind": "BINARY_OPERATOR_CHANGED",
          "subject": "FreezeService::canFreeze",
          "side": "head",
          "startLine": 9,
          "endLine": 9,
          "description": "運算子 < → <=：$cash->amount < $amount → $cash->amount <= $amount",
          "blockers": [
            "COMPARISON_OPERATOR_CHANGED"
          ],
          "anchor": {
            "operator": "<→<=",
            "before": "$cash->amount < $amount"
          },
          "scopeHash": "php:40bab854fa49c35a6ff61336b3b97707"
        }
      ],
      "changedLines": [
        {
          "side": "head",
          "startLine": 9,
          "endLine": 9
        }
      ],
      "track": "AI_TRACK",
      "oneWayDoors": [],
      "findings": []
    },
    {
      "path": "composer.json",
      "status": "modified",
      "contentHash": "git:b02624cbee377067feaae08dde39829b1f5cbe91",
      "analyzed": false,
      "decision": "HUMAN_REVIEW_REQUIRED",
      "fallback": "FULL",
      "reasons": [
        "UNSUPPORTED_FILE_TYPE"
      ],
      "facts": [],
      "changedLines": [
        {
          "side": "head",
          "startLine": 3,
          "endLine": 3
        }
      ],
      "track": "AI_TRACK",
      "oneWayDoors": [],
      "findings": []
    }
  ]
}
```

## Exit code 與錯誤

| exit code | 意義 |
|---|---|
| 0 | 完成。沒有 `--fail-on-review` / `--fail-on-escalation` 時，即使有檔案需要 review 也是 0；有 `--fail-on-review` 時表示 PR 層級為 `NOT_SELECTED_FOR_HUMAN_REVIEW`（包括 `NO_CHANGES`）；有 `--fail-on-escalation` 時表示 PR 層級路由不是 `ESCALATED` |
| 1 | 有 `--fail-on-review` 且 PR 層級為 `HUMAN_REVIEW_REQUIRED`，或有 `--fail-on-escalation` 且 PR 層級路由為 `ESCALATED` |
| 2 | 錯誤。stderr 印出 `error: <訊息>`，不輸出報表 |

exit code 2 的錯誤：

| 訊息 | 原因 |
|---|---|
| `OPTION_MISSING:--base` | 沒有 `--base`，或值為空字串 |
| `OPTION_INVALID:--<選項> <值>` | `--concurrency` 不是 1–64 的整數，或 `--timeout-ms` 不是 1–2147483647 的整數 |
| `GIT_REF_INVALID:<ref>` | ref 為空（例如 `--head ''`）或以 `-` 開頭（例如 `--base=-x`）。不存在的 ref 是 `GIT_FAILED` |
| `GIT_FAILED:git <子指令>: <git 的訊息>` | git 指令失敗，例如 ref 不存在（`fatal: Needed a single revision`，包括 shallow clone 沒有 fetch base）、`--repo` 不存在或不是 git repository、PATH 上沒有 `git`（`spawn git ENOENT`） |
| `GIT_NO_MERGE_BASE:<base SHA>..<head SHA>` | base 與 head 沒有共同祖先：不相關的歷史，或 shallow clone 沒有抓到 merge base |
| Node 參數解析的訊息 | 例如 `Unknown option '--foo'`、`Option '--base <value>' argument missing`、`Unexpected argument 'x'. This command does not take positional arguments` |
| Node 檔案系統的錯誤訊息 | `--out` 無法寫入，例如 `EISDIR: illegal operation on a directory, open '<file>'`（目標是目錄）、`EEXIST: file already exists, mkdir '<dir>'`（上層路徑是一般檔案）、`EACCES`（沒有權限）。報表在寫檔之後才印到 stdout，所以這時 stdout 也沒有報表 |

`GIT_DIFF_UNPARSABLE:<header>`（`git diff --raw` 的輸出無法解析）是防禦性檢查，正常執行不會出現；出現時也是 exit code 2。

analyzer 的問題（找不到 `php`、沒有安裝依賴、逾時）**不是** exit code 2，而是讓檔案變成 `FULL`（見「前置需求」與「原因代碼」）。

## 在 CI 中使用

```bash
# 在 Reviewer 的 checkout 中執行（第一次先 npm run analyzer:install）。
# PROJECT_DIR 是要 review 的專案，已 checkout 在 PR head，並有 base 的完整歷史。
# CI 的 shell 通常開著 errexit（bash -e），exit code 必須用 `|| status=$?` 取得。
status=0
node bin/review.js \
  --repo "$PROJECT_DIR" \
  --base "$BASE_REF" \
  --head HEAD \
  --fail-on-review \
  --out review/report.json || status=$?

if [ "$status" -eq 2 ]; then
  echo "review CLI 執行失敗" >&2
  exit 2
fi

# analyzer 本身的問題不會讓 exit code 變成 2，而是讓檔案變成 FULL；另外檢查
if ! jq -e '[.files[].reasons[]
             | select(startswith("ANALYZER_ERROR:")
                      or . == "COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING")]
           | length == 0' review/report.json > /dev/null; then
  echo "PHP analyzer 無法執行，請確認 php 與 npm run analyzer:install" >&2
  exit 2
fi

exit "$status"   # 0：不需要 Human Review；1：需要（清單見 review/report.json）
```

- `--fail-on-review` 的 exit code 1 表示「需要 Human Review」，不是 CLI 失敗；CLI 失敗是 2。
- GitHub Actions 的 `run:` 預設以 `bash -e` 執行（指定 `shell: bash` 時是 `bash -eo pipefail`），CLI 一以非 0 結束，step 就會中止。如果在 node 指令之後才另起一行寫 `status=$?`，那一行、exit code 2 的判斷與 analyzer 檢查都不會執行，「analyzer 無法執行」會被當成一般的 exit code 1（需要 review）。
- `--out` 讓 stdout 保留給人看的文字報表，同時留下 JSON 供後續步驟使用。
- `ANALYZER_ERROR:PHP_ANALYZER_ABORTED`（逾時）也會被上面的檢查擋下；大型檔案多時可以調高 `--timeout-ms`。
- 在 GitHub Actions 中，`actions/checkout` 預設只抓一個 commit，請設 `fetch-depth: 0`。否則 base 的 ref 不存在（`GIT_FAILED:git rev-parse: …`）；另外 fetch base 但深度不夠時，則是找不到 merge base（`GIT_NO_MERGE_BASE`）。見「比較範圍」。
- `pull_request` 事件中，`actions/checkout` 預設 checkout 的是 `refs/pull/<n>/merge`（GitHub 把 PR 合併到當時 base 的暫時 commit），不是 PR head。這時 `--head HEAD` 是這個合併 commit，比較起點會是合併當時 base 的最新 commit，而不是 PR 分支的 merge base，`head:` 的行號也是合併後版本的行號，與 GitHub「Files changed」中 PR head 的行號不一定相同。請同時設 `ref: ${{ github.event.pull_request.head.sha }}` 與 `fetch-depth: 0`，並以 `--base origin/${{ github.base_ref }}` 指定 base。

## 限制

- 決策是 file-level：`TARGETED` 的位置只是起點，仍需 review 整個檔案。
- 只分析 PHP（`.php`）。新增、刪除、非 PHP、binary、symlink、submodule、type change 一律 `FULL`，不會分析內容。
- 只比較 commit，不看 working tree。
- 需要 base 與 head 的共同歷史；shallow clone 可能缺少 base（`GIT_FAILED`）或找不到 merge base（`GIT_NO_MERGE_BASE`）。
- 不檢查目標 PHP 版本是否支援新語法（例如在 PHP 7 專案中使用參數 trailing comma），請以目標版本的 `php -l` 檢查。
- 判為等價時只檢查 PHP 8 與 PHP 7（7.4 語法）的解讀，不檢查 PHP 5 的語意。例如 `$$name['key']` 在 PHP 5 是 `${$name['key']}`，在 PHP 7 以後是 `${$name}['key']`；把它改成 `${$name}['key']` 仍會判為 `NOT_SELECTED_FOR_HUMAN_REVIEW`。PHP 5 專案的 `NOT_SELECTED_FOR_HUMAN_REVIEW` 不代表行為不變。其他刻意接受、不視為行為差異的情況見 [README「目前能力邊界」](../README.md#目前能力邊界)。
- analyzer 失敗與缺少依賴不會讓 CLI 以錯誤結束，CI 需另外檢查（見上）。
- JSON 的 fact 不含 fact id，`FACT_UNHANDLED:<id>` 無法直接對應到個別 fact。
- JSON 報表沒有 `schemaVersion`。

## 相關文件

- [README](../README.md)：專案概觀、已實作的 facts 與 interpreters、目前能力邊界。
- [目前能力整理](current-state.md)
- [Safety MVP / Review Decision Engine 架構](safety-mvp-architecture.md)
- [與 Agent Work Harness 的合作方式](integrations/agent-work-harness.md)
