# 三層審查架構（機械 → AI → 人工）設計

狀態：§8 的步驟 1–6 已實作（實作中遇到的問題與處理方式見 [實作紀錄](../notes/2026-10-19-three-tier-implementation-notes.md)），步驟 7–9 尚未實作。本文把「三層審查」藍圖對照目前的程式碼，標出哪些已存在、哪些要新增，以及新增時必須守住的 safety invariant。現有能力以 [README](../../../README.md) 與 [Current State](../../current-state.md) 為準。

已定案的決策：

- Fact 的 `callee`（與內嵌 callee 的 `container`）改成結構化欄位（§3.4）。
- 二次 review 的狀態存在 GitHub PR 留言中，不另設資料庫（§4.4）。
- 第二個支援的語言是 TypeScript / JavaScript（Node.js）（§3.5）。
- 專案設定使用 `.reviewer.json`（JSON），不使用 YAML（§3.2）。

## 0. 先校正藍圖與目前程式碼的差異

藍圖中有幾處描述和 repo 現況不一致，後續討論以本節為準：

| 藍圖說法 | 目前程式碼 |
|---|---|
| `php-laravel-domain.js` 帶有 `wallet` / `balance` 業務邏輯 | 沒有。15 個 interpreter 中，業務相關的只有 `idempotencyKey`（`PAYMENT_IDEMPOTENCY_INTERPRETER`）與簽章驗證 method 名稱的 regex（`SIGNATURE_VERIFICATION_INTERPRETER`）；其餘是 Laravel 框架規則（transaction、authorize、middleware、row lock、validation、model attributes）與語言層規則（運算子、guard、反轉、回傳值、參數順序、變數、常數）。`wallet` 只出現在 mutation corpus 的測試程式碼裡。 |
| `balance-sign-flip` | 沒有這個代碼。`-` → `+` 產生的是通用的 `ARITHMETIC_OPERATOR_CHANGED`，不知道變數是不是餘額。「敏感變數名」是新能力（§3.2）。 |
| `transaction-removed` / `guard-removed` / `row-lock-removed` | 實際代碼為 `TRANSACTION_BOUNDARY_REMOVED`、`TRANSACTION_ROLLBACK_REMOVED`、`GUARD_CLAUSE_REMOVED`、`AUTHORIZATION_GUARD_REMOVED`、`MIDDLEWARE_GUARD_REMOVED`、`ROW_LOCK_REMOVED`。 |
| `format-only` / `safe-local-rename` / `syntax-only-equivalent` 判定 | 沒有這些分類代碼。AST 等價的檔案只是 `NOT_SELECTED_FOR_HUMAN_REVIEW` + `NO_REDUCTION_BLOCKER`、沒有 fact；目前無法說出「為什麼等價」。若儀表板要顯示等價原因，analyzer 需另外輸出（§5.1）。 |
| `coverage-unsupported` | 對應 `fallback: FULL`：`COV-PHP-001:*`（無法解釋的變更、語法分歧、parse error）、`ANALYZER_*`，以及不送 analyzer 的 `FILE_ADDED`、`UNSUPPORTED_FILE_TYPE` 等。 |
| `contracts.js` 已是語言無關原語 | `src/facts/contracts.js` 只驗證 fact envelope（id / kind / subject / properties / provenance / source），不規定 `kind` 的詞彙。`kind` 名稱本身已是語言中立的，但 `callee`、`container` 是 PHP 語法字串（`$this->authorize`、`Route::group#0[middleware]`），規則換到其他語言會比對不到（§3.4）。 |
| 以 fact 當作跨 commit 的追蹤單位 | `fact.id` 是 `sha256(kind, path, subject, detail, startByte, endByte)`（`analyzers/php/src/CallFacts.php`），含 byte offset，**上方任何一行變動都會讓 id 改變**，不能直接當指紋（§4.1）。 |
| `evidence.js` 是機械層抓到的證據 | `src/evidence.js` 驗證的是外部提供的 evidence items；`bin/review.js` 目前不產生也不傳入 evidence / impact / invariants。高風險證據實際在 file result 的 `facts`（含 `description`、`side`、行號）與 `reasons`。 |

綁定程度總結：核心決策（`contracts`、`coverage`、`reducer`、`evidence`、`impact`、`invariants`、`summary`、`publication`、`storage`、`runner`）不綁語言也不綁業務；業務只有上述 2 條規則；框架綁 Laravel；語言綁 PHP（analyzer、運算子集合、`COV-PHP-001`）；接線寫死在 `src/review/review.js`（只有 `.php` 進 analyzer、adapter 與 interpreter 集合固定）。

目前「有任何 fact 就要人看」，所以業務規則只影響標示的精準度，不影響安全：套到物流專案時，庫存扣減的 `-` → `+` 仍會以 `ARITHMETIC_OPERATOR_CHANGED` 要求人工。業務規則在 §2 的路由讓非單向門略過人工之後才攸關安全，因此必須能由各專案補充，而且只能加嚴。

## 1. 不變的核心原則

三層架構是加在現有 deterministic core **外面**的路由與呈現層，不改變 core 的語意：

1. **只有第 1 層能放寬人工審查。** 第 2 層（AI）的輸出永遠是 advisory：可以讓結果變嚴格（補 comment、要求人工），不能把第 1 層判為需要人工的項目改成不需要。
2. **Fail-closed 不變。** unknown / incomplete / analyzer failure / 設定檔讀不到或格式錯誤 / 狀態留言驗證失敗，一律走最嚴格的路由。
3. **設定與規範從 base 讀，不從 head 讀。** `.reviewer.yaml` 與 `codingstandards.md` 若從 PR 本身讀取，PR 可以順手刪掉攔截自己的規則。兩者都從 merge base 讀；PR 修改這兩個檔案本身是單向門（§2）。
4. **所有影響決策的輸入都綁入 digest。** 專案設定與 preset 的內容 digest 要和 `interpreterSetDigest` 一樣進入 `AnalysisContextBinding`，否則相同 base/head、不同設定的結果會共用 authority。
5. **人工豁免綁定在內容上，不綁定在 PR 或時間上**（§4.2）。
6. **分析不執行目標程式碼。** PHP 與 TS analyzer 都只解析原始碼，不安裝目標專案的依賴、不執行其 script，因此可以在沒有 secret 的 job 中分析 fork PR（§4.5）。

## 2. 交接協議：第 1 層輸出 → 三種路由

目前 reducer 只輸出兩種決策，而且**每個 fact 都會讓檔案需要 review**。三層架構需要在 file result 上加一個路由欄位 `track`，由新的 `src/routing.js` 根據 decision、fallback、reasons 與專案設定計算：

| `track` | 條件 | 第 2 層（AI） | 第 3 層（人工） |
|---|---|---|---|
| `AUTO_PASS` | `decision === NOT_SELECTED_FOR_HUMAN_REVIEW` | 不送（不花 token） | 不需要 |
| `AI_TRACK` | `HUMAN_REVIEW_REQUIRED`、`fallback === TARGETED`，且所有 reasons 都**不在** one-way-door 集合中 | 只送這些檔案的 diff 與 facts，對照 `codingstandards.md` | 預設不需要；AI 標記業務疑問時才請人看 |
| `ESCALATED` | 任一 reason 在 one-way-door 集合中；或 `fallback === FULL`；或檔案符合 `protectedPaths`；或 PR 修改了 `.reviewer.yaml` / `codingstandards.md` | 只產生輔助材料（流程圖、摘要），不給結論 | 必須人工確認或豁免，Check 為 failure |

PR 層級的 `track` 取所有檔案中最嚴格的一個（`ESCALATED` > `AI_TRACK` > `AUTO_PASS`），與目前「所有檔案都不需 review 才是 NOT_SELECTED」的規則一致。

**One-way-door 集合**（預設，來自 preset，可由專案加嚴、不可刪除）分三類：

- 移除防護：`TRANSACTION_BOUNDARY_REMOVED`、`TRANSACTION_ROLLBACK_REMOVED`、`ROW_LOCK_REMOVED`、`AUTHORIZATION_GUARD_REMOVED`、`AUTHORIZATION_ABILITY_CHANGED`、`MIDDLEWARE_GUARD_REMOVED`、`SIGNATURE_VERIFICATION_REMOVED`、`GUARD_CLAUSE_REMOVED`、`PROTECTED_CALL_REMOVED`。
- 改變關鍵值：`PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED`、`SENSITIVE_OPERAND_CHANGED`、`MASS_ASSIGNMENT_CHANGED`、`SERIALIZED_ATTRIBUTES_CHANGED`。
- **新增不可逆的外部副作用**：`SIDE_EFFECT_CALL_ADDED`（寄信、推播、排入 queue、呼叫付款 API 等，見 §3.2 `sideEffectCalls`），以及資料刪除 `DATA_DELETION_ADDED`（`delete` / `forceDelete` / `truncate`、migration 中的 `dropColumn` / `dropTable` 等，由 preset 定義）。

第三類來自 AWS 單向門的典型例子（誤發信給大量使用者、資料遺失）。在目前的規則下，新增 `Mail::send` 只會產生 `CALL_ADDED` → `FACT_UNHANDLED`，若沒有這一類會被分到 `AI_TRACK`。

**PR 自我宣告與機械偵測交叉比對**：PR 描述可以宣告 `Merge-Risk: one-way | two-way` 與影響範圍，儀表板會顯示。宣告不會讓結果變寬鬆，只會讓結果變嚴格：宣告 `two-way` 但機械層偵測到單向門時，儀表板標示「宣告與偵測不一致」；宣告 `one-way` 時，即使機械層判為 `AI_TRACK` 也升級為 `ESCALATED`。

**`FULL` 的路由**：`FULL` 包含「新增檔案」「非 PHP 檔」。若全部走 `ESCALATED`，幾乎每個 PR 都會鎖死，減負效果歸零；若全部走 `AI_TRACK`，等於讓 AI 決定第 1 層看不懂的東西。建議：

- `COV-*`、`ANALYZER_*`、`PHP_*`、`TS_*` 這類「分析了但看不懂 / 失敗」→ 永遠 `ESCALATED`。
- `FILE_ADDED`、`UNSUPPORTED_FILE_TYPE` 等「沒有分析」→ 預設 `ESCALATED`；專案可在 `.reviewer.yaml` 用 `routing.aiTrackPaths` 明列可交給 AI 的路徑（例如 `tests/**`、`docs/**`、`resources/lang/**`）。不給萬用字元 `**` 的捷徑；`protectedPaths` 優先於 `aiTrackPaths`。

## 3. 去業務綁定：分層、設定檔與跨語言

### 3.1 四層結構

```
核心決策（不動）
  ↑ 語言中立的 fact 詞彙與結構化欄位（§3.4）
語言 Adapter：php、ts（每種語言一個）           ← Reviewer 維護
  ↑
框架 Preset：php-laravel、node-express、nestjs、prisma…  ← Reviewer 維護，跨專案共用
  ↑
專案設定 .reviewer.yaml：業務名詞、關鍵函式、敏感路徑   ← 各業務團隊維護
```

`src/interpreters/php-laravel-domain.js` 依此拆開：

| 類別 | 現有 interpreter | 去處 |
|---|---|---|
| 語言層（與框架、業務無關） | operator、guard clause、negation、return value、argument order、variable change、constant value | `src/interpreters/core.js`，所有語言共用，運算子集合依 fact 的 `language` 屬性選擇 |
| 框架層 | transaction boundary、authorization guard、middleware guard、row lock、validation rules、model attributes | `src/interpreters/presets/php-laravel.js` |
| 業務層 | payment idempotency（`idempotencyKey`）、signature verification（method 名稱 regex） | 由 `.reviewer.yaml` 宣告的通用規則引擎產生（§3.2）；`preset:payments` 提供目前的預設值，維持現有行為 |

每個 interpreter 保留 `id` / `version`；拆完後 mutation corpus 與 real-repo gate 必須維持相同結果（行為不變的重構）。

`src/review/review.js` 的接線改成依副檔名查表，未列出的副檔名照現在一樣走 `FULL`：

```js
const LANGUAGES = [
  { match: /\.php$/i, adapter: createPhpLaravelAdapter, presets: ['php-laravel'] },
  { match: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, adapter: createTypeScriptAdapter, presets: ['node'] },
];
```

### 3.2 專案設定 Schema（v1）

規則種類保持少而固定，業務團隊只填名詞，不寫程式。callee 比對使用 §3.4 的結構化欄位，因此同一條規則在 PHP 與 TS 都適用。

```yaml
version: 1
presets: [php-laravel, payments]       # 不寫時等同目前的 PHP_LARAVEL_DOMAIN_INTERPRETERS

rules:
  # 敏感運算元上的運算子改變（BINARY_OPERATOR_CHANGED）
  sensitiveOperands:
    - pattern: '(?i)(wallet|balance|amount|credit)'
      operators: arithmetic                           # arithmetic | comparison | any
  # 不可移除的呼叫（CALL_REMOVED）→ PROTECTED_CALL_REMOVED
  protectedCalls:
    - { name: verifySignature }
    - { name: '/^check\w*Permission$/i' }
    - { receiver: 'Gate', name: authorize }           # receiver 比對最後一段
  # 具名參數改變（CALL_ARGUMENT_CHANGED）
  protectedArguments:
    - { argument: idempotencyKey, blocker: PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED }
  # 新增即為單向門的外部副作用（CALL_ADDED）→ SIDE_EFFECT_CALL_ADDED
  sideEffectCalls:
    - { receiver: 'Mail', name: '/^(send|queue)$/' }
    - { receiver: 'PaymentGateway', name: charge }
  # 任何變更都是單向門的路徑
  protectedPaths: ['database/migrations/**', 'config/payment.php']
  # 只能把代碼加入 one-way-door 集合，不能移除預設值
  oneWayDoors: [CONSTANT_VALUE_CHANGED]

routing:
  aiTrackPaths: ['tests/**', 'docs/**']
```

物流專案只需換名詞，例如 `sensitiveOperands: [{ pattern: '(?i)stock|inventory|qty', operators: any }]`、`protectedCalls: [{ name: reserveStock }]`。

設計重點：

- 規則只能**新增** blocker 或擴大 one-way-door 集合，沒有「忽略某個 fact」的語法。要減少誤報，只能靠第 1 層 analyzer 的等價判定變強，不能靠設定關掉。
- 不接受目標 repo 自帶的 JS interpreter（等於讓 PR 在 CI 執行任意程式）；複雜規則做成 Reviewer 端的 preset。
- 規則引擎本身是一個 interpreter（`id: config-rules`），`version` 為引擎版本；設定內容的 canonical JSON digest 另外存成 `policyConfigDigest` 進入 context binding。
- 讀不到、parse 失敗、`version` 不認得、regex 無效 → 檔案全部 `FULL` + `POLICY_CONFIG_INVALID`。
- **格式選擇（待決）**：repo 目前沒有任何 runtime dependency，Node 24 也沒有內建 YAML parser。v1 可改用 `.reviewer.json`（`JSON.parse` 即可），或引入一個鎖定版本的 YAML 套件。schema 內容不受影響。

### 3.3 Fact 詞彙

把目前的 fact `kind` 列為正式詞彙（`src/facts/vocabulary.js`），每個 kind 規定必填的 properties。新 adapter 只能輸出詞彙中的 kind，或帶 `x-<language>-` 前綴的語言專屬 kind（沒有 interpreter 處理時照樣 `FACT_UNHANDLED`）。為了支援 TS 與 PHP 8 attributes，詞彙新增：

- `ANNOTATION_REMOVED` / `ANNOTATION_ADDED` / `ANNOTATION_ARGUMENT_CHANGED`：TS decorator（`@UseGuards`、`@Roles`、`@Transactional`）與 PHP 8 attribute（`#[IsGranted]`）共用。
- `DIRECTIVE_COMMENT_CHANGED`：有語意的註解，例如 `// @ts-ignore`、`// @ts-expect-error`、`/* eslint-disable */`、`/* @__PURE__ */`。這類註解不能被當成一般註解忽略。
- `CALL_ARGUMENT_REMOVED` / `CALL_ARGUMENT_ADDED`：參數被移除或新增（Express `router.post('/x', auth, handler)` 移除 `auth`）。原本 PHP 的參數數量改變一律是未解釋差異；`#index` 的 `CALL_ARGUMENT_CHANGED`（位置參數的值改變且無法被更細的 fact 解釋）是另一件事，維持不變。

### 3.4 結構化 callee 與 container（fact schema v2）

目前的 `callee: '$this->adminDB->transaction'`、`container: 'Route::group#0[middleware]'` 是 PHP 語法字串，interpreter 用 regex 拆解（`calleeParts`）。改成：

```js
properties: {
  callee: {
    text: '$this->adminDB->transaction',   // 原始語法，只供顯示
    name: 'transaction',                   // method / function 名稱
    receiver: ['this', 'adminDB'],         // 去掉語言符號的 receiver 路徑；無法化成路徑（呼叫鏈、運算式）時為 null
    kind: 'method',                        // method | static | function | constructor
    optional: false,                       // PHP ?-> / TS ?.
  },
  container: {
    type: 'argument',                      // argument | property | return | const | condition | array
    callee: { /* 同上，type 為 argument 時 */ },
    index: 0,
    key: 'middleware',                     // 陣列 / 物件的 key，沒有時為 null
  },
}
```

對照：

| 原始碼 | `name` | `receiver` | `kind` |
|---|---|---|---|
| `\DB::transaction(...)` | `transaction` | `['DB']` | `static` |
| `\Illuminate\Support\Facades\Gate::authorize(...)` | `authorize` | `['Illuminate','Support','Facades','Gate']` | `static` |
| `$this->adminDB->transaction(...)` | `transaction` | `['this','adminDB']` | `method` |
| `->lockForUpdate()`（鏈式） | `lockForUpdate` | `null` | `method` |
| `this.db.transaction(...)`（TS） | `transaction` | `['this','db']` | `method` |
| `prisma.$transaction(...)`（TS） | `$transaction` | `['prisma']` | `method` |
| `jwt.verify(token, key)`（TS） | `verify` | `['jwt']` | `method` |

規則比對 `receiver` 時預設只比最後一段（`Gate` 同時符合 `Gate` 與 FQN），需要精確比對時寫完整路徑。

影響範圍：PHP analyzer 輸出、`src/adapters/php-laravel/adapter.js` 的版本、所有 interpreter（刪除 `calleeParts` 的 regex 拆解）、`describeFact` 與 mutation corpus 的預期值。fact properties 改變會讓 `semanticFactsDigest` 改變，這是預期的；決策結果必須不變（mutation baseline 與 real-repo gate 相同）。

### 3.5 TypeScript / JavaScript Adapter

**Parser**：TypeScript compiler API（`typescript` 套件，鎖定版本）。同一個 parser 處理 `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs`，在 Node 中執行，不像 PHP 需要另外安裝語言 runtime。Tree-sitter 的錯誤容忍與語法細節不如官方 parser，不適合用來證明等價。

**執行方式**：與 PHP 相同，放在 `analyzers/ts/`（自己的 `package.json` 與 lockfile），以子行程執行 `node analyzers/ts/bin/analyze.js`，沿用 adapter runner 的 JSON 協定、逾時與 fail-closed 處理。Reviewer 主套件維持沒有 runtime dependency。不安裝也不執行目標專案的依賴。

**等價判定（Canonicalizer）必須處理的 JS/TS 特有情況**：

| 情況 | 處理 |
|---|---|
| 引號、分號、trailing comma、多餘括號、`1_000` / `1000` | 比較 AST，視為等價 |
| ASI（自動補分號）造成語意改變 | 比較 AST 已能反映，不需特別處理 |
| 型別註記、`as` 轉型、`interface` / `type` 變更 | **不視為等價**。執行期雖然被抹除，但 `as any` 之類會隱藏錯誤；v1 一律產生差異，之後可加 `TYPE_ANNOTATION_CHANGED` fact 交給 `AI_TRACK` |
| 區域變數改名 | 比照 PHP 做 scope-aware 正規化；scope 內出現 `eval`、`with`、`new Function`、非 strict mode 的 `arguments` 時整個 scope 不正規化 |
| 物件簡寫 `{ x }` 中的 `x` 改名 | **不等價**：會改變物件的 key |
| 解構、export 名稱、class member 名稱 | 不正規化（對外可見） |
| `function` ↔ 箭頭函式 | 不等價（`this` / `arguments` 綁定不同） |
| import 順序 | 不等價（模組副作用的執行順序） |
| JSX 文字的空白 | 依 JSX 空白規則正規化後再比較，排版可能改變實際渲染的空白 |
| `'use strict'`、`@ts-ignore`、`@__PURE__` 等指示 | 產生 fact，不當作註解忽略（§3.3） |
| `.d.ts`、`package.json`、lockfile | 不送 analyzer，`FULL`；`package.json` 建議列入 `protectedPaths` |

**Node 生態的 preset**（第 2、3 階段的範圍）：

| 單向門 | 對應的程式碼 |
|---|---|
| Transaction | `prisma.$transaction`、`knex.transaction`、`sequelize.transaction`、TypeORM `dataSource.transaction` / `queryRunner.startTransaction` / `commitTransaction` / `rollbackTransaction`、`@Transactional()` |
| Row lock | knex `.forUpdate()`、TypeORM `.setLock('pessimistic_write')`、Sequelize `lock: t.LOCK.UPDATE`、raw SQL 中的 `FOR UPDATE` |
| 授權 | Express / Fastify route 註冊中的 middleware 參數、`preHandler`、NestJS `@UseGuards` / `@Roles` |
| 簽章 / token 驗證 | `jwt.verify` 被移除或換成 `jwt.decode`、`crypto.timingSafeEqual`、`stripe.webhooks.constructEvent` |
| Validation | zod schema、class-validator decorator、Joi |

**分階段導入**（每一階段啟用前，該語言的 mutation corpus 必須達到 Critical Recall 100%、False Negative 0）：

| 階段 | Adapter 能做什麼 | 效果 |
|---|---|---|
| 0 | 沒有 adapter（現狀） | `UNSUPPORTED_FILE_TYPE`，一律 `FULL` |
| 1 | 只判斷 AST 是否等價；不等價時回報 `COV-TS-001:UNRECOGNIZED_TS_CHANGE` | 純排版 / 註解 / 區域變數改名的變更開始 `AUTO_PASS` |
| 2 | 呼叫的新增 / 移除 / 參數、decorator facts | 框架 preset 與專案 `protectedCalls` / `sideEffectCalls` 生效 |
| 3 | 運算子、guard、字面值、反轉、回傳值等其餘詞彙 | 單向門偵測與 PHP 對齊 |

mutation corpus（`evaluation/mutations/cases.json`）加上 `language` 欄位與 TS fixture；real-repo evaluation 的產生器目前是 PHP 專用（`evaluation/real-repo/generate.php`），TS 需要另寫一個。

## 4. 二次 Review 狀態追蹤

### 4.1 Finding 指紋

追蹤單位是「需要人工處理的項目」（finding），不是 fact。每個帶 one-way-door blocker 的 fact、以及每個 `ESCALATED` 但沒有 fact 的檔案各產生一個 finding：

```
finding_id = sha256(path, subject, kind, blocker, anchor, ordinal)
```

- `subject`：analyzer 已輸出的所屬 class / function（PHP `App\Services\WalletService::debit`；TS adapter 以 `WalletService.debit`、`debit` 等格式輸出，只用於比對與顯示）。
- `anchor`：fact 中不隨位置改變的內容。`CALL_REMOVED` 用結構化 callee（`name` + `receiver`），`BINARY_OPERATOR_CHANGED` 用運算子前後與運算元，`ARRAY_ITEM_REMOVED` 用 container + key。由 `src/findings.js` 依 kind 決定，未列出的 kind 用 canonical properties。
- `ordinal`：同一 subject 內 anchor 相同時依出現順序編號，避免兩件事被合併成一件。
- 不含 byte offset 與行號，所以上方插入程式碼不會讓 finding 變成新的。method 或檔案改名會產生新的 finding（保守：最多讓人多看一次）。
- 沒有 fact 的檔案以 `(path, 'FILE', reason)` 為 anchor。

### 4.2 局部 AST hash

豁免要綁定在「被看過的程式碼」上。analyzer 新增輸出：每個 fact 所屬 function / method 在 head 側的 canonical AST hash（排版、註解、區域變數改名不影響 hash；PHP 的 `Canonicalizer.php` 已有正規化邏輯，TS 的 Canonicalizer 共用同一套定義）。沒有所屬 function 的 fact（頂層、class property）以所屬 class 的 hash 或整檔 hash 取代，範圍越大越保守。沒有 fact 的檔案以整檔內容 hash 取代。

### 4.3 狀態機

狀態每次分析都從頭重算（merge base 對 head），不是與上一個 commit 比較：

| 前一狀態 | 新 head 分析結果 | 新狀態 |
|---|---|---|
| 任何 | finding 不再出現 | `FIXED`（呼叫 provider resolve thread） |
| `OPEN` / `REOPENED` | 仍出現，沒有有效豁免 | 維持 |
| 任何 | 仍出現，存在 `scopeHash` **與** `policyDigest` 都相同的豁免 | `ACKNOWLEDGED` |
| `ACKNOWLEDGED` | 仍出現，但 hash 或 policy digest 改變 | `REOPENED` |
| `FIXED` | 再次出現 | `REOPENED` |

- 因為每次都是 merge base 對 head 整體比較，`FIXED` 的意思是「這個 PR 已經不再包含這個風險變更」。作者把變更分散到多個 commit 也繞不過去。
- policy digest 納入豁免條件：interpreter 或設定升級後，同一段程式碼可能被解讀成不同風險，舊豁免不自動沿用。

### 4.4 狀態存在 GitHub 留言

不另設資料庫。狀態以隱藏區塊存在 bot 的置頂儀表板留言（§5.1）中：

```html
<!-- reviewer:state v1 sig=<HMAC-SHA256> -->
<!-- <base64(gzip(JSON))> -->
```

JSON 內容：

```js
{
  version: 1,
  pullRequest: 42,
  headSha: 'a1b2c3d…',
  policyDigest: '…',
  lastProcessedCommentId: 123456789,   // 已處理到哪一則 ack 指令
  nextShortId: 4,
  findings: {
    '<finding_id>': {
      shortId: 'F1',                    // 依序配發、永不重用，FIXED 後保留
      state: 'ACKNOWLEDGED',
      blocker: 'TRANSACTION_BOUNDARY_REMOVED',
      path: 'app/Services/WalletService.php',
      subject: 'App\\Services\\WalletService::debit',
      scopeHashes: { 'a1b2c3d…': '…' }, // 最近幾個 head 的局部 AST hash
      threadId: 'PRRT_…',
      firstSeenSha: '…', lastSeenSha: '…',
    },
  },
  acks: [                               // append-only
    { findingId: '…', userId: 1234, login: 'alice', sha: 'a1b2c3d…', scopeHash: '…',
      policyDigest: '…', commentId: 123456700, at: '2026-10-19T…' },
  ],
}
```

**豁免的流程**：

1. 儀表板每個待確認項目附上可複製的指令，例如 `/reviewer ack F1@a1b2c3d 已確認改由呼叫端包 transaction`。`@sha` 是儀表板顯示時的 head。
2. `issue_comment` 事件觸發 workflow，從 `lastProcessedCommentId` 之後依序處理指令留言：
   - 留言者必須有 repository write 以上權限（`GET /repos/{owner}/{repo}/collaborators/{user}/permission`），且不是 PR 作者；bot 帳號的留言忽略。
   - 被編輯過的指令留言（`updated_at` ≠ `created_at`）不採用，回覆要求重新留言。
   - `@sha` 對應的局部 AST hash 必須等於 finding 目前的 hash；不同代表人看完之後該 method 又改了，回覆拒絕並要求重看。這避免「人看的是 A，推了 B 之後才送出 ack，結果 ack 綁到 B」。
3. 通過的 ack 寫入 `acks`，更新儀表板與 Check，並回覆確認。

**完整性**：

- 有 write 權限的人都能編輯 bot 的留言，所以狀態以 HMAC 簽章（CI secret `REVIEWER_STATE_KEY`）。簽章不符、無法解碼或版本不認得時，**丟棄狀態**：所有 finding 回到 `OPEN`，再從 PR 的 ack 指令留言重新播放豁免（指令留言本身是不可偽造身分的紀錄；重播時 `@sha` 的 hash 若已無法驗證，該 ack 不採用）。結果只會更嚴格。
- 留言上限 65,536 字元。狀態經 gzip + base64，單一 PR 的 finding 通常很少；超過上限時改存在第二則隱藏留言，仍放不下則 fail-closed（所有 finding 視為 `OPEN`）並在儀表板說明。
- 同時有兩個 workflow 在跑（push 與 ack 留言）會造成更新遺失。以 GitHub Actions `concurrency: reviewer-pr-<number>`（`cancel-in-progress: false`）串行化；即使遺失，finding 每次都從頭重算，ack 則因為 `lastProcessedCommentId` 只在 PATCH 成功後才前進而會被重新處理。

**跨 PR 的統計**（§7 retro）直接透過 API 讀取一段期間內各 PR 的狀態留言，不需要資料庫。現有的 `SqliteAuthorityStore` 保留給 `runStoredAdapterPipeline` 的 authority CAS 使用；之後若需要，`AuthorityStore` port 也可以有 GitHub 留言實作。

### 4.5 GitHub Actions 的權限切分

fork PR 的 `pull_request` 事件拿不到 secret，也不能留言。採用兩段式：

1. `pull_request`：唯讀 token、沒有 secret，checkout 後執行分析（只解析、不執行目標程式碼），把報表上傳成 artifact。
2. `workflow_run`（分析完成後觸發）與 `issue_comment`：有寫入權限與 `REVIEWER_STATE_KEY`，**不 checkout PR 的程式碼**，只讀 artifact 與留言，更新儀表板、thread 與 Check。

## 5. 呈現

原則：不另外做網站，全部放在 PR 頁面上，並依風險決定位置。

| 位置 | 內容 | 理由 |
|---|---|---|
| 置頂留言（一則，原地更新） | 總覽、待確認清單、已處理項目、可略過檔案、隱藏狀態 | 打開 PR 第一眼就看到，不洗版 |
| 行內 thread | **只為 finding 開**，釘在觸發的行 | 在程式碼旁判斷；`AI_TRACK` 的 fact 不開，避免噪音 |
| Check | 有 `OPEN` / `REOPENED` finding 就 failure | 真正的閘門 |
| CLI | 本地自我檢查 | 已有（`bin/review.js`） |

### 5.1 置頂儀表板

`src/review/format.js` 新增 `formatDashboard(report, state)`，輸出 Markdown；`publisher.js` 現有的 `upsertSummary` 已是 upsert 語意，transport 以 `GITHUB_PUBLICATION_MARKER` 隱藏標記找到同一則留言 PATCH 即可，不需改 port。

```markdown
## 🔴 需要人工確認 · 單向門 2 項 · head a1b2c3d
宣告：Merge-Risk two-way ⚠️ 與偵測結果不一致
影響：WalletService::debit、OrderController::store

| # | 風險 | 位置 | 說明 | 狀態 |
|---|---|---|---|---|
| F1 | TRANSACTION_BOUNDARY_REMOVED | WalletService.php:42 | 移除 DB::transaction 包覆 | 🔴 待確認 |
| F2 | SENSITIVE_OPERAND_CHANGED | WalletService.php:57 | `$balance - $amt` → `+` | 🟠 重新開啟（確認後該 method 又改了） |

確認：`/reviewer ack F1@a1b2c3d <理由>`

<details><summary>流程圖（AI 產生，不影響合併判定）</summary> … </details>
<details><summary>🟢 已修正 1 · ✅ 已確認 1</summary> … </details>
<details><summary>機械層判定可略過 14 個檔案</summary> … </details>
<!-- reviewer:state v1 sig=… -->
```

若要在「可略過」清單附上「排版 / 區域變數改名」等原因，analyzer 需輸出等價類別，否則只列檔名。

### 5.2 行內 thread 與 suggestion

只為 finding 開 thread；finding 變成 `FIXED` 時自動 resolve，`REOPENED` 時 unresolve 並說明原因。`suggestion` 區塊只來自第 2 層，且只用於 `AI_TRACK` 檔案。

### 5.3 Check

Check conclusion 由分析結果與 finding 狀態共同決定：存在 `OPEN` / `REOPENED` finding → `failure`；否則 `success`。Check 綁定 head SHA，新 push 一定會產生新的 Check。

## 6. 第 2 層（AI）的邊界

- **輸入**：`AI_TRACK` 檔案的 diff、facts、`codingstandards.md`（從 base 讀）。不傳 `AUTO_PASS` 檔案；`ESCALATED` 檔案只請 AI 產生流程圖與摘要，不請它下結論或修改。
- **直接 commit 修正（待決，建議調整）**：藍圖與影片都預設直接 commit。AI 的 commit 是新的 head，第 1 層會重新分析，所以 AI 不可能用 commit 繞過單向門偵測；AI 產生的變更若觸發新的 finding，照常升級為 `ESCALATED`。剩下的風險只是 `AI_TRACK` 檔案中 AI 的修改沒有人看，這與「雙向門稍微看就好」的取捨一致。建議：`AI_TRACK` 檔案預設直接 commit；`ESCALATED` 檔案禁止 AI commit，只能留 suggestion。
- **與 Agent Work Harness 的分工**不變（見 [Agent Work Harness Integration](../../integrations/agent-work-harness.md)）：Harness 判斷 agent 工作是否完成，Reviewer 判斷是否需要人工；第 2 層 AI 是 Reviewer 的一部分，輸出不回寫 Harness 狀態。
- AI 呼叫失敗或逾時：該檔案升級為 `ESCALATED`（fail-closed），不是靜默略過。

## 7. Retro 閉環

週期性工作透過 API 讀取一段期間內各 PR 的狀態留言、ack 理由與人工 review comment：

1. 第一階：把人類重複留下的意見整理成 `codingstandards.md` 的修改 **PR**（不直接 push），由人合併。
2. 第二階：重複出現、結構明確的規則，產生 `.reviewer.yaml` 規則與 `evaluation/mutations/cases.json` 的 critical case 草案，同樣以 PR 提出；新規則必須先讓對應 mutation case 通過 `npm run eval:mutations` 才能合併。
3. **精簡**：`codingstandards.md` 中長期沒有被 AI 引用的條目、`.reviewer.yaml` 中豁免率長期很高的規則，提出刪除或改寫的 PR。豁免率高代表誤報，應回頭強化 analyzer，而不是放寬規則；規範檔太肥會讓審查 AI 表現變差。
4. 量測：每週輸出 `AUTO_PASS` / `AI_TRACK` / `ESCALATED` 比例、豁免率、`REOPENED` 次數、宣告與偵測不一致次數到 `$GITHUB_STEP_SUMMARY`。
5. AI session 的工作效率（找資料、工具使用）不在 Reviewer 的資料範圍內，屬於 Agent Work Harness。

## 8. 實作順序

每一步都可以單獨合併，且合併後 `npm run test:all` 與 mutation baseline 不變：

1. **Fact schema v2（行為不變）**：§3.4 的結構化 callee / container，PHP analyzer、adapter 版本、interpreter、`describeFact` 一起改；`CALL_ARGUMENT_REMOVED` / `ADDED` 取代 `#index`。
2. **拆分 interpreter 與語言查表（行為不變）**：§3.1 的 `core.js`、`presets/php-laravel.js`，`review.js` 改用副檔名查表。
3. **路由**：`src/routing.js` 與 file / PR 層級的 `track`，CLI `--json` 輸出新欄位，文字報表加一行。先用寫死的預設 one-way-door 集合。
4. **專案設定**：讀取（從 merge base）、`policyConfigDigest`、`config-rules` 規則引擎（含 `sideEffectCalls`、`protectedPaths`）、`POLICY_CONFIG_INVALID`；mutation corpus 加入對應的 critical case。
5. **TS adapter 第 1 階段**：`analyzers/ts/`、等價判定、TS mutation corpus（safe case 為主）。
6. **Finding 指紋與局部 AST hash**：PHP 與 TS analyzer 輸出 scope hash，`src/findings.js`；測試「上方插入程式碼後 finding id 不變」與「同 method 兩個相同 anchor 不合併」。
7. **GitHub 整合**：狀態留言的編解碼與簽章、狀態機、ack 指令處理、儀表板、thread、Check、兩段式 workflow。
8. **TS adapter 第 2、3 階段**與 Node preset。
9. **第 2 層 AI 與 retro**。

## 9. 待決事項

- 設定檔格式：JSON 或加入 YAML 依賴（§3.2）。
- `FULL` 中「未分析」檔案的預設路由（§2）。
- AI 是否在 `AI_TRACK` 檔案預設直接 commit（§6）。
- 豁免權限：repository write 即可，或必須是 CODEOWNERS（§4.4）。
- TS 型別變更是否在第 3 階段之後交給 `AI_TRACK`（§3.5）。
