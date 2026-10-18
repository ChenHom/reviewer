# 三層審查架構（機械 → AI → 人工）設計

狀態：設計草案，尚未實作。本文把「三層審查」藍圖對照目前的程式碼，標出哪些已存在、哪些要新增，以及新增時必須守住的 safety invariant。現有能力以 [README](../../../README.md) 與 [Current State](../../current-state.md) 為準。

## 0. 先校正藍圖與目前程式碼的差異

藍圖中有幾處描述和 repo 現況不一致，後續討論以本節為準：

| 藍圖說法 | 目前程式碼 |
|---|---|
| `php-laravel-domain.js` 帶有 `wallet` / `balance` 業務邏輯 | 沒有。15 個 interpreter 中，業務相關的只有 `idempotencyKey`（`PAYMENT_IDEMPOTENCY_INTERPRETER`）與簽章驗證 method 名稱的 regex（`SIGNATURE_VERIFICATION_INTERPRETER`）；其餘是 Laravel 框架規則（transaction、authorize、middleware、row lock、validation、model attributes）與語言層規則（運算子、guard、反轉、回傳值、參數順序、變數、常數）。`wallet` 只出現在 mutation corpus 的測試程式碼裡。 |
| `balance-sign-flip` | 沒有這個代碼。`-` → `+` 產生的是通用的 `ARITHMETIC_OPERATOR_CHANGED`，不知道變數是不是餘額。「敏感變數名」是新能力（§3.2）。 |
| `transaction-removed` / `guard-removed` / `row-lock-removed` | 實際代碼為 `TRANSACTION_BOUNDARY_REMOVED`、`TRANSACTION_ROLLBACK_REMOVED`、`GUARD_CLAUSE_REMOVED`、`AUTHORIZATION_GUARD_REMOVED`、`MIDDLEWARE_GUARD_REMOVED`、`ROW_LOCK_REMOVED`。 |
| `format-only` / `safe-local-rename` / `syntax-only-equivalent` 判定 | 沒有這些分類代碼。AST 等價的檔案只是 `NOT_SELECTED_FOR_HUMAN_REVIEW` + `NO_REDUCTION_BLOCKER`、沒有 fact；目前無法說出「為什麼等價」。若儀表板要顯示等價原因，analyzer 需另外輸出（§5.1）。 |
| `coverage-unsupported` | 對應 `fallback: FULL`：`COV-PHP-001:*`（無法解釋的變更、語法分歧、parse error）、`ANALYZER_*`，以及不送 analyzer 的 `FILE_ADDED`、`UNSUPPORTED_FILE_TYPE` 等。 |
| `contracts.js` 已是語言無關原語 | `src/facts/contracts.js` 只驗證 fact envelope（id / kind / subject / properties / provenance / source），不規定 `kind` 的詞彙。目前的 `kind`（`CALL_REMOVED`、`BINARY_OPERATOR_CHANGED`…）事實上已是語言中立的，但沒有被列為正式詞彙。 |
| 以 fact 當作跨 commit 的追蹤單位 | `fact.id` 是 `sha256(kind, path, subject, detail, startByte, endByte)`（`analyzers/php/src/CallFacts.php`），含 byte offset，**上方任何一行變動都會讓 id 改變**，不能直接當指紋（§4.1）。 |
| `evidence.js` 是機械層抓到的證據 | `src/evidence.js` 驗證的是外部提供的 evidence items；`bin/review.js` 目前不產生也不傳入 evidence / impact / invariants。高風險證據實際在 file result 的 `facts`（含 `description`、`side`、行號）與 `reasons`。 |

## 1. 不變的核心原則

三層架構是加在現有 deterministic core **外面**的路由與呈現層，不改變 core 的語意：

1. **只有第 1 層能放寬人工審查。** 第 2 層（AI）的輸出永遠是 advisory：可以讓結果變嚴格（補 comment、要求人工），不能把第 1 層判為需要人工的項目改成不需要。
2. **Fail-closed 不變。** unknown / incomplete / analyzer failure / 設定檔讀不到或格式錯誤，一律走最嚴格的路由。
3. **設定與規範從 base 讀，不從 head 讀。** `.reviewer.yaml` 與 `codingstandards.md` 若從 PR 本身讀取，PR 可以順手刪掉攔截自己的規則。兩者都從 merge base 讀；PR 修改這兩個檔案本身是單向門（§2）。
4. **所有影響決策的輸入都綁入 digest。** 專案設定與 preset 的內容 digest 要和 `interpreterSetDigest` 一樣進入 `AnalysisContextBinding`，否則相同 base/head、不同設定的結果會共用 authority。
5. **人工豁免綁定在內容上，不綁定在 PR 或時間上**（§4.2）。

## 2. 交接協議：第 1 層輸出 → 三種路由

目前 reducer 只輸出兩種決策，而且**每個 fact 都會讓檔案需要 review**。三層架構需要在 file result 上加一個路由欄位 `track`，由新的 `src/routing.js` 根據 decision、fallback、reasons 與專案設定計算：

| `track` | 條件 | 第 2 層（AI） | 第 3 層（人工） |
|---|---|---|---|
| `AUTO_PASS` | `decision === NOT_SELECTED_FOR_HUMAN_REVIEW` | 不送（不花 token） | 不需要 |
| `AI_TRACK` | `HUMAN_REVIEW_REQUIRED`、`fallback === TARGETED`，且所有 reasons 都**不在** one-way-door 集合中 | 只送這些檔案的 diff 與 facts，對照 `codingstandards.md` | 預設不需要；AI 標記業務疑問時才請人看 |
| `ESCALATED` | 任一 reason 在 one-way-door 集合中；或 `fallback === FULL`；或 PR 修改了 `.reviewer.yaml` / `codingstandards.md` | 只產生輔助材料（流程圖、摘要），不給結論 | 必須人工確認或豁免，Check 為 failure |

PR 層級的 `track` 取所有檔案中最嚴格的一個（`ESCALATED` > `AI_TRACK` > `AUTO_PASS`），與目前「所有檔案都不需 review 才是 NOT_SELECTED」的規則一致。

**One-way-door 集合**（預設，來自 preset，可由專案加嚴、不可刪除）：

```
TRANSACTION_BOUNDARY_REMOVED  TRANSACTION_ROLLBACK_REMOVED  ROW_LOCK_REMOVED
AUTHORIZATION_GUARD_REMOVED   AUTHORIZATION_ABILITY_CHANGED MIDDLEWARE_GUARD_REMOVED
SIGNATURE_VERIFICATION_REMOVED PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED
GUARD_CLAUSE_REMOVED          MASS_ASSIGNMENT_CHANGED       SERIALIZED_ATTRIBUTES_CHANGED
SENSITIVE_ARITHMETIC_CHANGED  PROTECTED_CALL_REMOVED        （後兩者見 §3.2）
```

**需要決定的取捨（FULL 的路由）**：`FULL` 包含「新增檔案」「非 PHP 檔」。若全部走 `ESCALATED`，幾乎每個 PR 都會鎖死，減負效果歸零；若全部走 `AI_TRACK`，等於讓 AI 決定第 1 層看不懂的東西。建議：

- `COV-*`、`ANALYZER_*`、`PHP_*` 這類「分析了但看不懂 / 失敗」→ 永遠 `ESCALATED`。
- `FILE_ADDED`、`UNSUPPORTED_FILE_TYPE` 等「沒有分析」→ 預設 `ESCALATED`；專案可在 `.reviewer.yaml` 用 `routing.aiTrackPaths` 明列可交給 AI 的路徑（例如 `tests/**`、`docs/**`、`resources/lang/**`）。不給萬用字元 `**` 的捷徑。

## 3. 去業務綁定：`.reviewer.yaml` 與 preset

### 3.1 拆分方式

`src/interpreters/php-laravel-domain.js` 拆成三類，對應不同的設定來源：

| 類別 | 現有 interpreter | 去處 |
|---|---|---|
| 語言層（與框架、業務無關） | operator、guard clause、negation、return value、argument order、variable change、constant value | `src/interpreters/php-core.js`，永遠啟用 |
| 框架層 | transaction boundary、authorization guard、middleware guard、row lock、validation rules、model attributes | `preset:php-laravel`，`src/interpreters/presets/php-laravel.js` |
| 業務層 | payment idempotency（`idempotencyKey`）、signature verification（method 名稱 regex） | 由 `.reviewer.yaml` 宣告的通用規則引擎產生（§3.2）；`preset:payments` 提供目前的預設值，維持現有行為 |

每個 interpreter 保留 `id` / `version`，所以拆檔不會改變 `interpreterSetDigest` 以外的任何東西；拆完後 mutation corpus 與 real-repo gate 必須維持相同結果（行為不變的重構）。

### 3.2 Schema（v1）

```yaml
version: 1
presets: [php-laravel, payments]       # 不寫時等同目前的 PHP_LARAVEL_DOMAIN_INTERPRETERS

rules:
  # 敏感變數上的算術 / 比較運算子改變 → 單向門
  sensitiveOperands:
    - pattern: '(?i)(wallet|balance|amount|credit)'   # 對 BINARY_OPERATOR_CHANGED 的 before/after 運算元比對
      operators: arithmetic                           # arithmetic | comparison | any
      blocker: SENSITIVE_ARITHMETIC_CHANGED

  # 不可移除的呼叫（CALL_REMOVED）
  protectedCalls:
    - callee: '->verifySignature'      # 精確比對 normalized callee 的結尾
      blocker: PROTECTED_CALL_REMOVED
    - method: '(?i)^check\w*permission$'
      blocker: PROTECTED_CALL_REMOVED

  # 具名參數改變（CALL_ARGUMENT_CHANGED）
  protectedArguments:
    - argument: idempotencyKey
      blocker: PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED

  oneWayDoors: [CONSTANT_VALUE_CHANGED]   # 只能把代碼加入 one-way-door 集合，不能移除預設值

routing:
  aiTrackPaths: ['tests/**', 'docs/**']
```

設計重點：

- 規則只能**新增** blocker 或擴大 one-way-door 集合，沒有「忽略某個 fact」的語法。要減少誤報，只能靠第 1 層 analyzer 的等價判定變強，不能靠設定關掉。
- 規則引擎本身是一個 interpreter（`id: config-rules`），`version` 為引擎版本；設定內容的 canonical JSON digest 另外存成 `policyConfigDigest` 進入 context binding。
- 讀不到、parse 失敗、`version` 不認得、regex 無效 → 檔案全部 `FULL` + `POLICY_CONFIG_INVALID`。
- **格式選擇**：repo 目前沒有任何 runtime dependency，Node 24 也沒有內建 YAML parser。建議 v1 改用 `.reviewer.json`（`JSON.parse` 即可，錯誤易於 fail-closed），或引入一個鎖定版本的 YAML 套件。這是需要團隊決定的事項，schema 內容不受影響。

### 3.3 跨語言

- 把目前的 fact `kind` 列為正式詞彙（`src/facts/vocabulary.js`），新 adapter 只能輸出詞彙中的 kind，或帶 `x-` 前綴的語言專屬 kind（沒有 interpreter 處理時照樣 `FACT_UNHANDLED`）。藍圖提到的 `atomic_block_removed` 等更抽象的原語，可以是 preset 層把 `CALL_REMOVED(DB::transaction)` 映射出來的 blocker，不需要改 adapter 輸出。
- 新語言初期沒有 adapter：`review.js` 現有規則會讓這些檔案以 `UNSUPPORTED_FILE_TYPE` 走 `FULL`，依 §2 預設為 `ESCALATED`，不是 `AI_TRACK`。若要讓新語言先交給 AI，必須用 `aiTrackPaths` 明確選擇，代價由專案承擔。

## 4. 二次 Review 狀態追蹤

### 4.1 Finding 指紋

追蹤單位是「需要人工處理的項目」（finding），不是 fact。每個帶 one-way-door blocker 的 fact、以及每個 `FULL` 檔案各產生一個 finding：

```
finding_id = sha256(path, subject, kind, blocker, anchor)
```

- `subject`：analyzer 已輸出的所屬 class / function（例如 `App\Services\WalletService::debit`）。
- `anchor`：fact 中不隨位置改變的內容，例如 `CALL_REMOVED` 用 normalized callee、`BINARY_OPERATOR_CHANGED` 用 `operatorBefore→operatorAfter` 與運算元、`ARRAY_ITEM_REMOVED` 用 container + key。由 `src/findings.js` 依 kind 決定，未列出的 kind 用 canonical properties。
- 不含 byte offset 與行號，所以上方插入程式碼不會讓 finding 變成新的。
- 同一 method 內有兩個相同 anchor 的 finding 時加上序號（第 n 個），避免碰撞把兩件事合併成一件。
- `FULL` 檔案的 finding 以 `(path, 'FILE', reason)` 為 anchor。

### 4.2 局部 AST hash

豁免要綁定在「被看過的程式碼」上。analyzer 需新增輸出：每個 fact 所屬 function / method 在 head 側的 canonical AST hash（`Canonicalizer.php` 已有正規化邏輯，排版、註解、區域變數改名不影響 hash）。沒有所屬 function 的 fact（頂層、class property）以所屬 class 的 hash 或整檔 hash 取代，範圍越大越保守。

### 4.3 資料表

接在現有 `authority_current` 旁，不修改它：

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  repository      TEXT NOT NULL,
  pull_request    INTEGER NOT NULL,
  finding_id      TEXT NOT NULL,
  path            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  blocker         TEXT NOT NULL,
  scope_ast_hash  TEXT,                 -- 最近一次看到時的局部 AST hash；FULL 檔案為 NULL
  state           TEXT NOT NULL CHECK (state IN ('OPEN', 'FIXED', 'ACKNOWLEDGED', 'REOPENED')),
  first_seen_sha  TEXT NOT NULL,
  last_seen_sha   TEXT NOT NULL,
  thread_id       TEXT,                 -- provider 的 review thread id，用於 resolve
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (repository, pull_request, finding_id)
);

CREATE TABLE IF NOT EXISTS review_acknowledgements (
  repository      TEXT NOT NULL,
  pull_request    INTEGER NOT NULL,
  finding_id      TEXT NOT NULL,
  acknowledged_by TEXT NOT NULL,        -- provider user id，不是顯示名稱
  scope_ast_hash  TEXT NOT NULL,        -- 豁免當下的局部 AST hash
  policy_digest   TEXT NOT NULL,        -- 豁免當下的 interpreterSetDigest + policyConfigDigest
  head_sha        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (repository, pull_request, finding_id, created_at)
);
```

豁免是 append-only 紀錄，狀態轉換由每次分析重新計算，不就地修改豁免：

| 前一狀態 | 新 head 分析結果 | 新狀態 |
|---|---|---|
| 任何 | finding 不再出現 | `FIXED`（呼叫 provider resolve thread） |
| `OPEN` / `REOPENED` | 仍出現，沒有有效豁免 | 維持 |
| 任何 | 仍出現，存在 `scope_ast_hash` **與** `policy_digest` 都相同的豁免 | `ACKNOWLEDGED` |
| `ACKNOWLEDGED` | 仍出現，但 hash 或 policy digest 改變 | `REOPENED` |
| `FIXED` | 再次出現 | `REOPENED` |

`FULL` 檔案的 finding 沒有局部 hash，豁免改綁整檔內容 hash；檔案任何變動都會讓豁免失效。policy digest 納入豁免條件，是因為 interpreter 或設定升級後，同一段程式碼可能被解讀成不同風險，舊豁免不應自動沿用。

### 4.4 豁免的來源必須可驗證

藍圖建議在置頂留言打勾 `- [x]`。風險：留言是 bot 的，但任何有 write 權限的人都能編輯它，Issue comment 的 webhook 也不會直接告訴你「誰勾了哪一格」。因此：

- **權威來源**為 `/reviewer ack <short-finding-id> [理由]` 指令留言（或 GitHub review comment 回覆），由 webhook 帶入留言者 id，再查詢其 repository permission / CODEOWNERS 身分；PR 作者本人不能豁免自己的 finding。
- 核取方塊只當 UI：若要支援打勾，必須透過 GraphQL `userContentEdits` 取得編輯者並套用相同的權限檢查；查不到編輯者時視為無效，並在下一次更新留言時把勾取消。

## 5. 呈現

### 5.1 置頂儀表板

`src/review/format.js` 新增 `formatDashboard(report, findings)`，輸出 Markdown；`publisher.js` 現有的 `upsertSummary` 已是 upsert 語意，transport 以 `GITHUB_PUBLICATION_MARKER` 隱藏標記找到同一則留言 PATCH 即可，不需改 port。內容順序：

1. 狀態列：PR `track`、`ESCALATED` 數量、待處理 / 已豁免 / 已修正數、head SHA。
2. 🔴 待人工確認：每個 `OPEN` / `REOPENED` finding 一行，含 blocker、`path:line`（連到 head）、description、short finding id 與 ack 指令範例。
3. AI 輔助材料（僅 `ESCALATED`）：Mermaid 流程圖，明確標示「AI 產生，不影響合併判定」。
4. 🟢 已修正 / 已豁免（`<details>` 摺疊，豁免列出豁免者）。
5. 機械層判定可略過的檔案（`<details>` 摺疊）。若要附上「排版 / 區域變數改名」等原因，analyzer 需輸出等價類別，否則只列檔名。

### 5.2 行內 thread 與 suggestion

只為 finding 開 thread，fact 沒有對應 finding 的不開（避免 `AI_TRACK` 的檔案被機械層洗版）。`suggestion` 區塊只來自第 2 層，且只用於 `AI_TRACK` 檔案。

### 5.3 Check

Check conclusion 由 authority candidate 與 finding 狀態共同決定：存在 `OPEN` / `REOPENED` finding → `failure`；否則依 track 為 `success`。結論必須在同一個 head SHA 的 authority CAS 成功後才發布，沿用 `runStoredAdapterPipeline` 的保證。

## 6. 第 2 層（AI）的邊界

- **輸入**：`AI_TRACK` 檔案的 diff、facts、`codingstandards.md`（從 base 讀）。不傳 `AUTO_PASS` 檔案，也不傳 `ESCALATED` 檔案的修改建議請求。
- **直接 commit 修正**：藍圖預設 AI 直接 commit。建議預設改為 `suggestion`，由作者點擊套用；專案可開啟 `aiTier.autoCommit`。不論哪一種，AI 的 commit 都是新 head，第 1 層會重新分析（`advanceCurrentHead` 會清除舊 candidate），所以 AI 修正不可能繞過機械層；AI 產生的變更若觸發新的 one-way-door finding，照常升級為 `ESCALATED`。
- **與 Agent Work Harness 的分工**不變（見 [Agent Work Harness Integration](../../integrations/agent-work-harness.md)）：Harness 判斷 agent 工作是否完成，Reviewer 判斷是否需要人工；第 2 層 AI 是 Reviewer 的一部分，輸出不回寫 Harness 狀態。
- AI 呼叫失敗或逾時：該檔案升級為 `ESCALATED`（fail-closed），不是靜默略過。

## 7. Retro 閉環

週期性工作讀取 `review_findings`、`review_acknowledgements` 與人工 review comment：

1. 第一階：把人類重複留下的意見整理成 `codingstandards.md` 的修改 **PR**（不直接 push），由人合併。
2. 第二階：重複出現、結構明確的規則，產生 `.reviewer.yaml` 規則與 `evaluation/mutations/cases.json` 的 critical case 草案，同樣以 PR 提出；新規則必須先讓對應 mutation case 通過 `npm run eval:mutations` 才能合併。
3. 量測：每週輸出 `AUTO_PASS` / `AI_TRACK` / `ESCALATED` 比例、豁免率、`REOPENED` 次數到 `$GITHUB_STEP_SUMMARY`。豁免率長期很高的 blocker 代表誤報，應回頭強化 analyzer，而不是放寬規則。

## 8. 實作順序

每一步都可以單獨合併，且合併後 `npm run test:all` 與 mutation baseline 不變：

1. **拆分 interpreter（行為不變）**：§3.1 的三個檔案，`PHP_LARAVEL_DOMAIN_INTERPRETERS` 維持相同成員與順序。
2. **路由**：`src/routing.js` 與 file / PR 層級的 `track`，CLI `--json` 輸出新欄位，文字報表加一行。先用寫死的預設 one-way-door 集合。
3. **專案設定**：`.reviewer.json`（或 YAML）讀取、從 merge base 讀、`policyConfigDigest` 綁入 context binding、`config-rules` 規則引擎、`POLICY_CONFIG_INVALID`；mutation corpus 加入敏感運算元與 protected call 的 critical case。
4. **Finding 指紋與局部 AST hash**：analyzer 輸出 scope hash，`src/findings.js` 計算 finding id，加上「在上方插入程式碼後 finding id 不變」與「同 method 兩個相同 anchor 不合併」的測試。
5. **狀態表與狀態機**：`schema.sql` 新表、memory / SQLite 兩個 store 都實作，沿用現有 transaction 寫法。
6. **儀表板與 GitHub transport**：`formatDashboard`、真正呼叫 GitHub API 的 transport（目前 repo 內沒有）、ack 指令處理。
7. **第 2 層 AI 與 retro**。

## 9. 待決事項

- `FULL` 中「未分析」檔案的預設路由（§2）。
- 設定檔格式：JSON 或加入 YAML 依賴（§3.2）。
- AI 預設直接 commit 還是 suggestion（§6）。
- 豁免權限：repository write 即可，或必須是 CODEOWNERS（§4.4）。
- 狀態庫部署位置：CLI 在 CI 中執行時，SQLite 檔案需要跨 run 保存（artifact、cache 或外部 DB），否則二次 review 狀態無從延續。
