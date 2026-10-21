# 功能總覽

到目前為止，Reviewer 能做什麼、怎麼用、細節在哪。本文是入口，不重複各文件的完整內容：CLI 選項與原因代碼以 [PR Review CLI](review-cli.md) 為準，驗證數字以 [README「目前驗證基準」](../README.md#目前驗證基準) 為準。

## 一句話

Reviewer 是 deterministic、fail-closed 的 Review Decision Engine：對 PR 的每個變更檔案回答「在目前可驗證的證據下，哪些可以不選入人工 Review」。它不是替人做完整的 Code Review；unknown、不完整、analyzer 失敗都不會被解讀成安全。

## 三層審查流程

```text
git diff（head 相對於 base 與 head 的 merge base）
        │
        ▼
第 1 層：機械審查（deterministic，bin/review.js）
  analyzer → semantic facts → domain interpreters → 逐檔決策
        │
        ├─ 不需要 review ─────────────────────► AUTO_PASS：到此結束
        ├─ 需要 review，沒有命中單向門 ────────► AI_TRACK ──┐
        └─ 命中單向門 ─────────────────────────► ESCALATED ─┤
                                                           ▼
                                      第 2 層：AI 審查（--ai，需要 ANTHROPIC_API_KEY）
                              AI_TRACK：PASS 放行／FIX 修正／NEEDS_HUMAN 或 AI 失敗 → 人工
                              ESCALATED：AI 只補充說明，不能放行 → 一律人工
                                                           ▼
                                                 第 3 層：人工確認
```

沒有 `--ai` 時第 2 層不執行：`AI_TRACK` 檔案沒有人或 AI 看過，所以也算需要人工（`--fail-on-human` 會失敗）。路由不改變機械審查的 `decision`。

## 快速開始

```bash
npm ci && npm run analyzer:install   # 需要 Node.js、PHP CLI ≥ 8.3、Composer 2、git
node bin/review.js --repo /path/to/project --base origin/master --head HEAD
reviewer review --repo /path/to/project --base origin/master                    # 安裝成指令（npm i -g github:ChenHom/reviewer）時
node bin/review.js --repo /path/to/project --base origin/master --ai --fail-on-human   # 加上 AI 審查（需要 ANTHROPIC_API_KEY）
```

前置需求與完整選項見 [PR Review CLI](review-cli.md#前置需求)。要在其他專案使用，可以安裝成 `reviewer` 指令（子指令 `review`、`state`、`retro`、`doctor`）：TS/JS analyzer 的依賴隨 npm 安裝，PHP analyzer 的依賴不隨套件提供、要自己以 Composer 安裝，見 [README](../README.md#安裝成-reviewer-指令在其他專案使用)。

## 機械審查與兩個 adapter

- 送進 analyzer 的只有 PHP（`.php`）與 TypeScript / JavaScript（`.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs`、`.cjs`，不含 `.d.ts`）檔案的修改與 rename。新增、刪除、其他語言、binary、symlink、submodule 一律 `FULL`。
- PHP analyzer 以 nikic/php-parser 解析 AST（需要 PHP CLI ≥ 8.3 與 Composer 依賴）；TS / JS analyzer 以 TypeScript compiler API 解析，用執行 CLI 的同一個 Node。版本分別鎖定在 `analyzers/php/composer.lock` 與根目錄的 `package-lock.json`。
- 兩者都做 AST 等價判定（排版、註解、引號、一致的區域變數改名等不算差異），並把無法視為等價的差異表示成 semantic facts，例如 `CALL_REMOVED`、`BINARY_OPERATOR_CHANGED`、`GUARD_REMOVED`。
- fact 交給 `src/interpreters/` 的 deterministic 規則：preset `php-laravel`、`payments`（PHP 預設）與 `node`（TS / JS 預設）。有規則的 fact 產生具體原因（如 `TRANSACTION_BOUNDARY_REMOVED`），沒有的是 `FACT_UNHANDLED`。
- 無法解釋的變更不猜：回報 `COV-PHP-001:*` / `COV-TS-001:*` 並判為 `FULL`。fact 與 interpreter 的完整清單見 [README「已實作」](../README.md#已實作)。

## 決策：`TARGETED` 與 `FULL`

- 每個檔案只有兩種決策：`NOT_SELECTED_FOR_HUMAN_REVIEW`（兩個版本在 AST 比較下等價、不是 rename 或權限變更，而且沒有被專案政策攔下）或 `HUMAN_REVIEW_REQUIRED`。PR 層級只有在所有檔案都不需要 review 時才是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- `HUMAN_REVIEW_REQUIRED` 分兩種：`TARGETED`（每個變更都已被 fact 解釋；或內容等價，但被專案政策攔下，例如 `PROTECTED_PATH`、`POLICY_FILE_CHANGED`）與 `FULL`（有無法解釋的變更、檔案沒有或無法分析，或專案設定無效 `POLICY_CONFIG_INVALID`）。兩者都要看整個檔案，差別是 Reviewer 是否已經知道每個變更是什麼。
- 輸出的行號是 review 的起點，不是範圍：reduction 是 file-level，不是 region-level。
- 語意與完整表格見 [PR Review CLI「決策語意」](review-cli.md#決策語意)，檔案分類順序見[「檔案分類」](review-cli.md#檔案分類)。

## 三層路由與單向門

- 每個檔案的 `track`：`AUTO_PASS`、`AI_TRACK`、`ESCALATED`（PR 層級取最嚴格者）。命中單向門（做了就難以回頭，如移除 transaction、授權檢查、簽章驗證，或新增資料刪除）的檔案是 `ESCALATED`。
- 預設單向門清單在 `src/routing.js` 的 `DEFAULT_ONE_WAY_DOORS`；專案設定只能加入，不能移除。不認得的 `decision` 或 `track` 當成 `ESCALATED`。
- 必須人工確認的項目有穩定的 finding id 與 scope hash（`src/findings.js`），上方插入程式碼或區域變數改名不改變 id。
- `--fail-on-escalation` 在有檔案命中單向門時失敗；沒有 `--ai` 時它不涵蓋 `AI_TRACK`，見 [PR Review CLI「路由」](review-cli.md#路由三層審查)。

## 專案設定

- `.reviewer.json`（schema version 1）選擇 preset，並加入業務相關規則：`sensitiveOperands`、`protectedCalls`、`protectedArguments`、`sideEffectCalls`、`protectedPaths`、`oneWayDoors`。`codingstandards.md` 是給 AI 審查層讀的軟性規範。
- 兩者都從 merge base 讀取，PR 修改它們不影響這次 review，修改本身是單向門 `POLICY_FILE_CHANGED`。
- 設定只能新增攔截。檔案無效時每個變更檔案都是 `FULL` 加 `POLICY_CONFIG_INVALID`（也是單向門）。
- CI 本身（`.github/workflows/**`、`.github/actions/**`）不論有沒有設定都是受保護路徑：任何變更（包括排版）都產生 `PROTECTED_PATH` 並成為 `ESCALATED`，AI 不能放行，也不能以 `--ai-apply` 修改。這只是判斷訊號：GitHub 對 `pull_request` 執行的是 PR 版本的 workflow，要防止 PR 直接拿掉 Reviewer 那一步，需要 branch protection 把它設為 required check。
- 格式與範例見 [專案設定](project-config.md)。

## AI 審查（`--ai`、`--ai-apply`）

- `--ai` 把 `AI_TRACK` 與 `ESCALATED` 檔案逐一交給 Claude（預設 `claude-opus-5-5`、effort `high`），依 merge base 的 `codingstandards.md` 審查；以 structured outputs 取得 `PASS` / `NEEDS_HUMAN` / `FIX`、疑慮與（單向門檔案的）流程圖。
- `AI_TRACK` 由 AI 放行或交給人工；`ESCALATED` 不能被放行；AI 失敗（API 錯誤、拒絕、輸出截斷或格式錯誤、輸入太大、超過檔案數上限）一律交給人工。
- `--ai-apply` 把 `AI_TRACK` 檔案的小修正寫入 worktree（不 commit；worktree 必須是乾淨的 head）。修正先重新過機械審查，命中單向門或無法完整分析時不套用；**例外**：不支援的檔案類型（例如 `.json`、`.yml`）沒有 analyzer 可檢查，修正會照樣套用（`src/ai/review.js`）。commit 後要重新 review。
- 邊界：AI 輸出不是 deterministic、每個檔案單獨審查、diff 與規範當成資料處理（prompt injection 防護）。AI 層只以假的 client 測試，沒有對真實 API 做過 smoke test。
- 細節見 [PR Review CLI「AI 審查」](review-cli.md#ai-審查第-2-層--ai)。

## 二次 review 狀態（`bin/review-state.js`）

- 以 `bin/review.js --out` 的報表重算人工確認的狀態：🚪 單向門每個 finding 一項；🤖 AI 的疑慮、AI 失敗、沒有 AI 審查等以檔案為單位一項（AI 的輸出不是 deterministic，逐條確認會在重跑時失效）。
- 狀態：`OPEN`（待確認）、`ACKNOWLEDGED`（已確認）、`REOPENED`（確認後程式碼或規則改變，或修正後再次出現）、`FIXED`（已修正）。有 `OPEN` / `REOPENED` 時 Check 為 `failure`。
- 確認指令 `/reviewer ack F1-3fa2@<head> <理由>`：需要 write 以上權限、不能是 PR 作者、留言不能被編輯過；`@head` 是確認者看到的版本，看完之後程式碼或規則又改了就拒絕。全形符號視為半形，引用與程式碼區塊中的指令不算。
- 狀態以 HMAC 簽章存在置頂儀表板留言的最後；被竄改、換 key 或遺失時丟棄並從確認留言重算（結果只會更嚴格）。
- 輸出儀表板 Markdown、Check 結論、指令回覆與行內 thread 的目標狀態；**不呼叫 GitHub API**，寫回 PR 的 workflow 尚未實作。
- 用法與規則見 [二次 review 狀態](review-state.md)。

## Retro（`bin/retro.js`）

- 彙整一段期間內 `bin/review.js --out` 留下的 JSON 報表，計算 deterministic 指標：路由比例、各單向門的觸發與未觸發、`FULL` 的原因、沒有規則的 fact、AI 結果與成本、`codingstandards.md` 條目被引用的次數、人工留言。
- 加上 `--ai` 時提出草案：`codingstandards.md` 增刪、`.reviewer.json` 規則（逐條以設定驗證器檢查）、mutation case 草案（以機械審查確認會產生預期的原因代碼）。
- `--out-dir` 寫出 `retro.md`、`retro.json`，有建議時另寫 `reviewer.proposed.json`、`mutation-drafts.json`。retro 不修改任何既有檔案，也不開 PR；AI 建議同樣只以假的 client 測試。
- 用法與指標見 [Retro](retro.md)。

## 輸出格式與 exit code

- 預設是文字報表：機械審查後依路由分段列出檔案、原因與變更位置；`--json` 改輸出 JSON，`--out <file>` 另外寫一份 JSON。有 `--ai` 時報表改為「需要人工確認」「AI 已修正」「AI 審查通過」三段。
- JSON 頂層有 `decision`、`routing`、`ai`、`human`、`config` 與逐檔的 `files[]`（`facts`、`findings`、`needsHuman`、`ai`）。finding 帶 `scopeHash` 與 `policyDigest`（人工確認綁定的程式碼與規則）。報表沒有 `schemaVersion`。
- exit code：0 完成；1 只在加上 `--fail-on-review`、`--fail-on-escalation` 或 `--fail-on-human` 且條件成立時出現；2 錯誤。analyzer 缺依賴或找不到 `php` 不是 2，而是讓檔案變成 `FULL`，CI 需要另外檢查。
- 欄位、原因代碼與 CI 範例見 [PR Review CLI](review-cli.md#json-報表)。

## 驗證與 release gate

- `npm run test:all` 依序執行 lint、safety tests、E2E、coverage（c8 門檻）、mutation evaluation、historical evaluation。CI 在它之外還安裝兩個 analyzer 的依賴，並對 PHP 檔跑 `php -l`。
- 真實專案的 Real-repo evaluation（`npm run eval:real-repo`）不在 gate 內。
- 數字（Recall、Reduction Rate 等）只記在 [README「目前驗證基準」](../README.md#目前驗證基準)，包括各數字的量測條件與限制；測試策略見 [Safety MVP 測試策略](testing/safety-mvp-test-strategy.md)。
- 指令與環境需求見 [AGENTS.md](../AGENTS.md)。

## 發佈與 authority 相關模組

- 這組模組提供「分析結果只能綁定目前 head 發布」的機制，由 library pipeline（`src/runner.js`）與測試使用；`bin/review.js` 不經過 authority store，也不發布。
- `src/publication.js`：candidate 的 identity（repository、base / head SHA、policy、runner 版本）與 adapter context binding 必須和目前 head 相符才會成為 authoritative；過期的分析回報 `STALE_ANALYSIS_IDENTITY`，不會覆蓋結果。
- `src/storage/`：authority store 介面，以 compare-and-swap 保存 head 與 authoritative candidate；有 memory 與 SQLite（`node:sqlite`）兩種實作。
- `src/summary.js`：candidate digest、Summary 與 check state 的推導。
- `src/integrations/github/`：provider-neutral 的發布邊界，`publishGithubResult()` 驗證 payload 後呼叫注入的 transport（`upsertSummary`、`upsertCheck`）。專案內沒有真實的 GitHub transport。
- 架構見 [Safety MVP / Review Decision Engine 架構](safety-mvp-architecture.md)與[操作與失敗處理](operations/safety-mvp-next-phase.md)。

## 尚未實作與已知限制

- 三層架構設計 §8 的步驟 7（GitHub 整合）只完成 CLI 部分（`bin/review-state.js`）：沒有讀取留言、寫回儀表板 / 回覆 / thread / Check 的 workflow，也沒有 PR 自我宣告的風險（`Merge-Risk`）。因此 retro 的豁免率、REOPENED 次數列為不可用。
- AI 層與 retro 的 AI 建議只以假的 client 測試，從實作紀錄看沒有對真實 API 做過 smoke test。
- 決策是 file-level；只分析 PHP 與 TS / JS；只比較 commit，不看 working tree；需要 base 與 head 的共同歷史（shallow clone 常缺）。
- PHP 的等價判定只檢查 PHP 8 與 PHP 7 的解讀，不檢查 PHP 5 的語意，也不檢查目標版本是否支援新語法。
- Historical evaluation 目前只有 controlled fixture pilot，不代表真實世界 benchmark 已完成；Real-repo evaluation 的數字是本機一次性量測，無法只靠本 repo 重現。
- 完整清單見 [PR Review CLI「限制」](review-cli.md#限制)與 [README「目前能力邊界」](../README.md#目前能力邊界)。

## 延伸閱讀

| 想知道 | 看這裡 |
|---|---|
| 專案概觀、已實作的 facts 與 interpreters、驗證數字 | [README](../README.md) |
| 在 repo 工作的指令、慣例與不要改動的東西 | [AGENTS.md](../AGENTS.md) |
| CLI 用法、選項、原因代碼、JSON 報表、CI | [PR Review CLI](review-cli.md) |
| `.reviewer.json` 格式 | [專案設定](project-config.md) |
| Retro 用法與指標 | [Retro](retro.md) |
| 三層架構的設計與實作時遇到的問題 | [設計](superpowers/specs/2026-10-18-three-tier-review-design.md)、[實作紀錄](superpowers/notes/2026-10-19-three-tier-implementation-notes.md) |
| 架構、安全邊界與 production seams | [架構](safety-mvp-architecture.md)、[目前能力整理](current-state.md) |
| 測試規範 | [Safety MVP 測試策略](testing/safety-mvp-test-strategy.md) |
| 與 Agent Work Harness 的合作 | [整合方式](integrations/agent-work-harness.md) |
| 在真實 PHP 專案上評估 | [Real-repo Evaluation](../evaluation/real-repo/README.md) |
