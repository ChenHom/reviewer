# Agent Work Harness Integration

本文定義 Reviewer 與 `ChenHom/agent-work-harness` 的合作方式。

這不是把兩個專案合成同一個系統，也不是讓 Harness 變成 code review engine。

Reviewer 目前的入口是 PR review CLI `node bin/review.js`。它的用法、選項、比較範圍、exit code、原因代碼與 JSON 報表格式以 [PR Review CLI](../review-cli.md) 為準；本文只說明 Harness 與 GitHub 整合時怎麼使用它，以及還缺什麼。

## 1. 責任邊界

兩個系統回答不同問題。

### Agent Work Harness

負責：

> 「這次 agent 工作是否可信地完成？」

它觀察：

- Work Contract
- Repository Contract
- Agent authority
- git diff evidence
- protected / denied paths
- test / lint / typecheck / build
- runtime protocol
- recovery / retry / durable execution

輸出偏向：

```
SUCCESS
FAILED
BLOCKED
POLICY_VIOLATION
NEEDS_USER_DECISION
```

### Reviewer

負責：

> 「這些已完成的變更裡，哪些仍需要人工 Review？」

它觀察：

- merge base 與 head 兩個 commit 的檔案內容
- changed regions
- semantic facts
- coverage
- deterministic domain policy
- unresolved evidence / impact / invariants（pipeline 只在收到外部提供的這些資料時才檢查；`bin/review.js` 目前不產生也不傳入，所以 PR review 不會考慮這三層）

輸出（每個變更檔案一個決策，再彙整成 PR 層級決策）：

```
HUMAN_REVIEW_REQUIRED（TARGETED / FULL）
NOT_SELECTED_FOR_HUMAN_REVIEW
```

`TARGETED` / `FULL` 區分的是 Reviewer 是否已經知道每個變更是什麼，不是要看的範圍大小；兩者都要 review 整個檔案（見 §9）。

因此：

```
Harness SUCCESS
!=
不需要人工 Review
```

也同樣：

```
Reviewer HUMAN_REVIEW_REQUIRED
!=
Harness verification FAILED
```

## 2. 正確資料流

建議流程：

```
Codex / Claude Code
        ↓
Agent Work Harness
        │
        ├─ git evidence
        ├─ path policy
        ├─ test
        ├─ lint
        ├─ typecheck
        └─ build
        ↓
Harness SUCCESS（attempt 的結果需先 commit，見 §6）
        ↓
Reviewer（node bin/review.js）
        │
        ├─ Adapter
        ├─ Semantic Facts
        ├─ Domain Interpreters
        ├─ Coverage
        ├─ Eligibility
        └─ Reducer
        ↓
Review 報表（逐檔決策，JSON）
   ┌──────────────────────────────┬──────────────────────────────┐
   ▼                              ▼
HUMAN REVIEW（TARGETED / FULL）   NOT SELECTED FOR HUMAN REVIEW
   │
   ▼
Human / AI Reviewer（看完整檔案）
```

Reviewer 應接在 Harness verification 之後，而不是取代 Harness verification。

## 3. 不建議的接法

### 不要把 Reviewer 當普通 verification check

Harness Repository Contract 現在有：

```json
{
  "verification": {
    "checks": [
      {
        "id": "test",
        "kind": "test",
        "argv": ["npm", "test"],
        "required": true
      }
    ]
  }
}
```

不建議直接加：

```json
{
  "id": "reviewer",
  "kind": "custom",
  "argv": ["node", "<reviewer>/bin/review.js", "--base", "<base-sha>", "--fail-on-review"],
  "required": true
}
```

原因：

Harness verification 的語意是：

```
PASS / FAIL
```

Reviewer 的語意是：

```
Review Scope
```

`HUMAN_REVIEW_REQUIRED` 不是 verification failure。

加上 `--fail-on-review` 時，exit code 1 代表「需要 Human Review」，放進 `verification.checks` 就會被當成 FAIL，把「程式驗證失敗」與「這個檔案仍值得人看」混成同一件事。不加時，只有 Reviewer 本身出錯（exit code 2）才會讓 check 失敗，又變成把 Reviewer 執行失敗當成程式驗證失敗。

`--fail-on-review` 是給獨立的 CI review gate 用的（見 [PR Review CLI](../review-cli.md)「在 CI 中使用」），不是給 Harness verification 用的。

## 4. 建議整合契約

未來 Harness 可增加獨立 review provider contract，直接呼叫目前的 CLI：

```json
{
  "review": {
    "enabled": true,
    "provider": "reviewer",
    "argv": [
      "node", "<reviewer>/bin/review.js",
      "--repo", "<workspace>",
      "--base", "<base-sha>",
      "--head", "<head-sha>",
      "--out", "review_scope.json"
    ]
  }
}
```

它必須與 `verification` 分離。

`--out` 把 JSON 報表寫到檔案，stdout 保留給人看的文字報表，可以直接存成 log。

Provider 處理結果的方式（exit code 的完整定義見 [PR Review CLI](../review-cli.md)「Exit code 與錯誤」）：

- 不加 `--fail-on-review`。Review scope 以 JSON 報表的 `decision` 與 `files[]` 判斷，不看 exit code。
- exit code 0：報表已產出，不論是否需要 review。但 exit code 0 不代表 analyzer 都有執行成功，仍要檢查 `files[].reasons`（見 §5「前置需求」）。
- exit code 2：Reviewer 執行失敗（參數錯誤、ref 不存在、base 與 head 沒有 merge base、git 失敗等），stderr 為 `error: <訊息>`，不會產出報表。記為 Reviewer 執行失敗，不是 verification failure，也不是 review scope。

Harness report 可呈現：

```
Attempt Result
────────────────
SUCCESS

Verification
────────────────
test       PASS
lint       PASS
typecheck  PASS
path       PASS

Review Scope
────────────────
Changed          17
Human Review      5   (TARGETED 3, FULL 2)
Not Selected     12
Reduction       70.6%
```

Changed、Human Review、Not Selected 對應報表的 `decision.files`、`decision.targeted + decision.full`、`decision.notSelected`。CLI 不輸出 reduction 比例，Reduction 由 Harness 以 `decision.notSelected / decision.files` 計算。`decision.files` 為 0（`decision.reasons` 為 `["NO_CHANGES"]`）時沒有 reduction 可算，應顯示為沒有變更，不要做 0 / 0 的除法。

Review scope 不應反向修改 Harness Outcome；Reviewer 執行失敗也一樣。

## 5. Reviewer 目前的入口與尚缺的部分

### 目前：`node bin/review.js`

Reviewer 已有 PR 層級的 multi-file CLI（`bin/review.js` 與 `src/review/`）。可以從任何目錄以 Reviewer checkout 中的 `bin/review.js` 呼叫（`<reviewer>` 為 Reviewer checkout 的路徑，`--repo` 指向要 review 的專案）：

```bash
node <reviewer>/bin/review.js \
  --repo /workspace/project \
  --base <base-ref> \
  --head <head-ref> \
  --out review_scope.json
```

- `--base` / `--head` 可以是任何能解析成 commit 的 git ref（branch、tag、commit SHA）；`--head` 預設 `HEAD`。
- 要在 stdout 取得 JSON 時改用 `--json`；沒有 `--format` 選項。
- 完整選項見 [PR Review CLI](../review-cli.md)「用法」。

它目前的流程：

1. 以 `git merge-base <base> <head>` 為比較起點，用 `git diff -M <merge base> <head>` 取得變更檔案（含 rename 偵測），與 GitHub PR 的「Files changed」相同。
2. 只把 `.php` 的修改與 rename 送進 PHP Adapter；其他變更不分析（見下方「檔案處理規則」）。
3. 套用 production interpreter set：`src/interpreters/php-laravel-domain.js` 的 `PHP_LARAVEL_DOMAIN_INTERPRETERS`。
4. 逐檔決策，再以 `summarizeFiles`（`src/review/review.js`）彙整成 PR 層級決策。
5. 輸出文字報表，或以 `--json` / `--out` 輸出 JSON 報表。這份報表還不是正式的 Review Scope Plan（見下方「尚未提供」）。

比較範圍：

- 比較的內容只來自 git 物件（commit、tree、blob），不讀 working tree 或 index；未 commit 的變更不會被 review。
- 但 `--repo` 必須是有 work tree 的 repository（一般 clone 或 `git worktree`）：CLI 以 `git rev-parse --show-toplevel` 找 repository 根目錄，bare repository 會以 `GIT_FAILED:git rev-parse: fatal: this operation must be run in a work tree` 結束（exit code 2）。
- base 在 head 分出後才有的 commit 不算在內。報表的 `base.sha` 仍是 `--base` 指向的 commit，`mergeBase` 才是實際的比較起點。
- base 與 head 沒有共同歷史時以 `GIT_NO_MERGE_BASE` 結束（exit code 2）；shallow clone 沒抓到 merge base 時也是如此。
- 細節見 [PR Review CLI](../review-cli.md)「比較範圍：merge base」。

檔案處理規則（對 Harness 特別重要）：

- 只有修改或 rename 的 `.php` 檔會被分析。新增與刪除的 PHP 檔、非 PHP 檔、binary、symlink、submodule、type change，以及 analyzer 執行失敗的檔案，一律是 `HUMAN_REVIEW_REQUIRED` / `FULL`，不分析內容。
- rename 與檔案權限變更即使內容等價也要求 review（此時為 `TARGETED`）。
- PR 層級只有在**所有**檔案都是 `NOT_SELECTED_FOR_HUMAN_REVIEW` 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- 因此 agent 新增的檔案永遠不會被縮減；Not Selected 只會來自內容在 AST 比較下等價、沒有改名也沒有改權限的既有 `.php` 修改。
- 各情況的原因代碼見 [PR Review CLI](../review-cli.md)「檔案分類」與「原因代碼」。

### 前置需求

執行 Reviewer 的環境（Harness worker 或 GitHub runner）需要 `git`、Node.js、PATH 上的 `php`（PHP CLI ≥ 8.3；CI 使用 8.4），並在 Reviewer 的 checkout 先執行 `npm run analyzer:install`（以 Composer 2 安裝鎖定版本的 `nikic/php-parser` 5.9.0）。完整說明見 [PR Review CLI](../review-cli.md)「前置需求」。

PHP 環境不完整時 CLI **不會**以錯誤結束：每個送進 analyzer 的 PHP 檔都變成 `FULL`，原因是 `ANALYZER_ERROR:*`（例如找不到 `php` 時的 `ANALYZER_ERROR:spawn php ENOENT`，或依賴已安裝但 `php` 低於 8.3 時的 `ANALYZER_ERROR:PHP_ANALYZER_EXIT_<code>:…`）或 `COV-PHP-001:PHP_ANALYZER_DEPENDENCY_MISSING`（沒有執行 `npm run analyzer:install`；以 PHP 8.0–8.2 執行它會因 `php >= 8.3` 的要求失敗，也是這種情況），exit code 仍是 0。報表看起來像正常結果，只是 Not Selected 為 0。

`ANALYZER_ERROR:*` 不一定代表環境不完整：單一檔案超過 `--timeout-ms`（預設 30000 毫秒）時 analyzer 會被終止，原因是 `ANALYZER_ERROR:PHP_ANALYZER_ABORTED`；analyzer 對某個輸入以非 0 結束或輸出不是 JSON 時也是 `ANALYZER_ERROR:*`。這時只有那些檔案變成 `FULL`，exit code 同樣是 0。

Harness 與 GitHub workflow 必須檢查 `files[].reasons`。出現這些原因代表 analyzer 沒有產生結果，當成 Reviewer 執行問題處理（不是 verification failure），不發布成 Review Scope，也不拿來計算 reduction。逾時的情況可以調高 `--timeout-ms` 後重跑。檢查方式見 [PR Review CLI](../review-cli.md)「在 CI 中使用」。

### Harness 會用到的報表欄位

JSON 報表的完整格式見 [PR Review CLI](../review-cli.md)「JSON 報表」。整合主要用到：

| 需要的資訊 | 目前來源 |
|---|---|
| base / head commit | `base.sha`、`head.sha` |
| 實際比較起點 | `mergeBase` |
| PR 層級決策 | `decision.status`、`decision.reasons` |
| 檔案數 | `decision.files`、`decision.notSelected`、`decision.targeted`、`decision.full` |
| 每個檔案的決策 | `files[]` 的 `path`、`decision`、`fallback`、`reasons` |
| review 起點 | `files[]` 的 `changedLines` 與 `facts[]` 行號（只是起點，見 §9） |
| reduction 比例 | 報表沒有；以 `decision.notSelected / decision.files` 計算 |
| Reviewer 版本、analysis identity | 報表沒有（見下方「尚未提供」） |

### 尚未提供

- 可安裝的 `reviewer` 指令與 `plan` subcommand。`package.json` 沒有 `bin`，目前只能以 `node <reviewer>/bin/review.js` 呼叫。`reviewer plan` 是將來可能包裝成的名稱。
- working-tree 模式。Harness 必須先把 attempt 的結果 commit，才能交給 Reviewer。
- 有版本的 Review Scope JSON schema。目前的報表：
  - 沒有 `schemaVersion`，欄位可能隨版本改變。
  - `repository` 只是 repository 根目錄的名稱，不是 `owner/repo`。
  - 所有變更檔案放在同一個 `files[]`，以各自的 `decision` 區分，沒有分成兩個清單。
  - 沒有 reduction metrics。
  - 沒有 Reviewer 版本與 analysis identity（`reviewRange` 內部使用的 `policyId` / `policyVersion` / `runnerVersion` 不在報表中）。

提案中的 Review Scope Plan 格式（**尚未實作**，目前的 CLI 不輸出這個格式）：

```json
{
  "schemaVersion": "1",
  "repository": "example/repo",
  "baseSha": "abc123",
  "mergeBaseSha": "0a1b2c",
  "headSha": "def456",
  "reviewScope": {
    "humanReviewRequired": [
      {
        "path": "app/Services/PaymentService.php",
        "fallback": "TARGETED",
        "reasons": [
          "PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED"
        ]
      }
    ],
    "notSelected": [
      {
        "path": "app/DTO/UserDTO.php"
      }
    ]
  },
  "metrics": {
    "changedFiles": 17,
    "humanReviewFiles": 5,
    "notSelectedFiles": 12,
    "reviewScopeReduction": 0.706
  }
}
```

正式 schema 也應帶 Reviewer 版本與 analysis identity，讓 Harness 能保存（§6）。

## 6. Harness 需要補的入口

Reviewer 已有 `bin/review.js`，Harness 不必等 `reviewer plan` 就可以增加：

```bash
harness review <workId>
```

流程：

```
workId
  ↓
latest successful Attempt
  ↓
attempt.baseRevision 與 attempt 結果的 commit
  ↓
node <reviewer>/bin/review.js --repo <workspace> --base <baseRevision> --head <結果 commit> --out review_scope.json
  ↓
檢查 exit code 與 analyzer 錯誤（§4、§5「前置需求」）
  ↓
review_scope.json
  ↓
Harness Artifact Store
  ↓
Review Scope section
```

Reviewer 只讀 commit，所以 attempt 實際改出的 tree 必須先成為 commit；working tree 中未 commit 的變更不會出現在報表裡。結果 commit 是從 `attempt.baseRevision` 長出來的時候，merge base 就是 `attempt.baseRevision`，報表的 `mergeBase` 與 `base.sha` 相同。

`--repo` 要指向含有這兩個 commit、而且有 work tree 的 repository。Harness 的 commit 如果只存在 bare repository（例如 artifact 或 attempt store），要先從它開一個 `git worktree` 或 clone 再交給 Reviewer，直接傳 bare repository 會以 `GIT_FAILED` 結束（§5「比較範圍」）。

Harness 應保存：

- Reviewer command/version。目前報表沒有 Reviewer 版本，Harness 需自行記錄實際的 argv 與 Reviewer checkout 的 commit。
- base/head SHA：`base.sha`、`head.sha`，以及實際的比較起點 `mergeBase`。
- Reviewer analysis identity。目前報表沒有，要等有版本的 Review Scope schema（§5）。
- raw `review_scope.json` artifact。
- Review scope summary。
- publication/event trace。

可增加事件：

```
review.scope.created
review.scope.published
```

但這些事件不改寫原本的 verification evidence。

## 7. GitHub PR 上的使用方式

Harness 在 attempt 完成後對 attempt 的 commit 跑 Reviewer，適合開發完成後立即看 review scope。

真正 PR 上則應以 GitHub PR 的 base 與 head 重新跑 Reviewer，避免依賴舊的 attempt 結果。

`bin/review.js` 會自己計算 merge base，所以：

- `--base` 傳 PR 的目標分支（例如 `origin/main`）或 PR 的 base SHA。base 分支在 PR 分出後才有的 commit 不會被算進來。
- `--head` 明確傳 PR head 的 commit（`pull_request.head.sha`）。`pull_request` 事件下 `actions/checkout` 預設 checkout 的是 GitHub 產生的 test merge commit，不是 PR 分支本身，而 `--head` 預設為 `HEAD`。
- checkout 要有 base 與 head 的 commit，以及兩者到 merge base 的歷史（例如 `actions/checkout` 設 `fetch-depth: 0`），否則會以 exit code 2 結束：base 或 head 的 commit 沒有抓下來時是 `GIT_FAILED`（`fatal: Needed a single revision`；`actions/checkout` 預設的 `fetch-depth: 1` 就是這種情況），兩者都在但共同歷史被截斷時是 `GIT_NO_MERGE_BASE`。

建議 GitHub workflow：

```
pull_request opened / synchronize / reopened
        ↓
checkout 專案（fetch-depth: 0）與 Reviewer
        ↓
setup PHP ≥ 8.3 + npm run analyzer:install
        ↓
node <reviewer>/bin/review.js --repo <專案目錄> --base <目標分支> --head <PR head SHA> --out review.json
        ↓
exit code 2 或 analyzer 錯誤 → 回報 Reviewer 錯誤
        ↓
Review Decision Summary
        ↓
GitHub Check / PR Summary
```

這個 workflow 還不存在：本 repo 的 CI（`.github/workflows/review-reduction-safety.yml`）只跑 Reviewer 自己的 release gate，不會在 PR 上執行 `bin/review.js`。`bin/review.js` 本身也只輸出到 stdout 與 `--out` 的檔案，不會建立 GitHub Check 或留言，最後兩步要由 workflow 讀 JSON 報表產生。CI 中檢查 exit code 與 analyzer 錯誤的寫法見 [PR Review CLI](../review-cli.md)「在 CI 中使用」。

範例：

```
Review Reduction / Scope

Changed files          17
Human Review Required   5   (TARGETED 3, FULL 2)
Not Selected           12
Review Scope Reduction 70.6%

HUMAN REVIEW（每個檔案都要看完整內容；位置只是起點）
- FULL      app/Services/ReportService.php
  COV-PHP-001:UNRECOGNIZED_PHP_CHANGE
- TARGETED  app/Services/PaymentService.php
  PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED  起點 head:L87
- TARGETED  app/Services/WalletService.php
  TRANSACTION_BOUNDARY_REMOVED  起點 base:L42
...

NOT SELECTED
- app/DTO/UserDTO.php
- app/ValueObjects/Money.php
...
```

人工 Reviewer 要看的檔案從 17 個縮到 5 個；這 5 個檔案都要看完整內容（§9）。Review Scope Reduction 由 workflow 以 `decision.notSelected / decision.files` 計算，CLI 不輸出這個比例。

## 8. Codex / Claude Code 如何使用

Codex / Claude Code 可以是 Review Scope 的 consumer，但不能成為 reduction authority。

建議：

```
Reviewer（node bin/review.js --json）
  ↓
Review 報表
  ↓
只把 HUMAN_REVIEW_REQUIRED files 的完整內容提供給 AI reviewer
（changedLines 與 fact 行號只當提示）
```

這會同時縮小：

- Human Review 範圍。
- AI Review context。
- token 使用。
- 重複看低風險 diff 的成本。

縮小的是檔案數，不是每個檔案要看的行數。`changedLines` 與 fact 行號可以放進 prompt 當起點，但不可只送標示的行（§9）。

可以另外提供一個薄 skill：

```
review-scope
```

只負責呼叫（Harness 補上 §6 的入口後）：

```bash
harness review <workId>
```

或目前就能用的：

```bash
node <reviewer>/bin/review.js --repo <path> --base <ref> --head <ref> --json
```

Skill 不得自行把檔案改成 `NOT_SELECTED`，也不得把需要 review 的檔案縮成只看標示的行。

## 9. File-level 與 Region-level

目前建議產品承諾停在：

> 縮減需要人工 Review 的「檔案集合」。

目前 semantic facts 雖然有 byte provenance，但 blocker 尚未正式建立：

```
blocker
  ↓
factId
  ↓
provenance
```

的完整、可驗證 selection contract。

因此目前不應宣稱：

```
PaymentService.php 只有 line 83-91 要看，其餘不用看
```

`bin/review.js` 會輸出行號，但它們不是 region-level reduction：

- `files[].changedLines`：`git diff -U0` 的 hunk 範圍（文字報表的「變更位置」）。只有需要 review 的檔案有這個欄位。
- `files[].facts[]` 的 `side` / `startLine` / `endLine`：fact provenance 換算成 merge base（`base`）或 head 版本的行號。

這些位置只是 review 的起點，不是 review 範圍。`reasons`（blocker）沒有連到個別 fact 或行號；JSON 的 fact 也不含 fact id，`FACT_UNHANDLED:<fact id>` 無法對應到個別 fact。也就是上面的 `blocker → factId → provenance` 仍未建立。

- `TARGETED`：檔案中每個變更都已被具體 fact 解釋（或內容等價、只有 rename / 權限改變）。原因與位置說明變了什麼、從哪裡開始看。
- `FULL`：至少有一個變更無法被解釋，或檔案沒有（或無法）分析。

兩者都需要 review 整個檔案。Harness、AI reviewer 與 skill 都不得把行號當成「只需看這幾行」。決策語意見 [PR Review CLI](../review-cli.md)「決策語意」。

Region-level reduction 應在 file-level reduction 經真實 Historical PR corpus 驗證後再做（目前 `npm run eval:historical` 只有 1 個 pilot case）。

## 10. Authority 原則

整合後仍應保持：

```
Agent / LLM
    ↓
提出變更 / 找問題 / 解釋
    ↓
Machine Facts
    ↓
Deterministic Policy
    ↓
Evidence
    ↓
Decision
```

LLM 可以協助：

- 找 hypothesis。
- 解釋 blocker。
- 對 selected scope 做 Review。

LLM 不應直接授權：

```
NOT_SELECTED_FOR_HUMAN_REVIEW
```

這個 authority 必須留在 Reviewer deterministic pipeline。

## 11. 建議實作順序

```
1. PR 層級 multi-file CLI（部分完成：node bin/review.js 已能對 merge base..head 逐檔決策；尚無可安裝的 reviewer 指令與 plan subcommand）
2. multi-file aggregation contract（已有實作：summarizeFiles，所有檔案都不需 review 才是 NOT_SELECTED，沒有變更時為 NO_CHANGES）
3. Review Scope JSON schema（schemaVersion、reviewScope、metrics、Reviewer 版本與 analysis identity）
4. harness review <workId>
5. Harness artifact / trace integration
6. GitHub PR workflow（在 pull_request 上執行 bin/review.js 並產生 Check / Summary）
7. 真實 Historical PR corpus
8. region-level blocker → provenance binding
```

這樣 Reviewer 與 Harness 都維持單一職責，不會演化成兩套互相重疊的 coding agent / review agent。
