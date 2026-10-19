# 專案設定（`.reviewer.json`）

各業務專案在自己的 repository 根目錄放 `.reviewer.json`，告訴 Reviewer：

- 啟用哪些框架 / 業務 preset；
- 哪些業務名詞、函式與路徑是單向門（做了就難以回頭：AI 審查後一律交給人工確認）。

其他需要 review 的變更都交給 AI 審查，由 AI 判斷是否需要人工（見 [PR Review CLI「路由」](review-cli.md#路由三層審查)）。

設計理由見 [三層審查架構設計](superpowers/specs/2026-10-18-three-tier-review-design.md) §3。軟性的團隊規範（命名、測試寫法等）不放這裡，放 `codingstandards.md` 給 AI 審查層讀。

## 讀取規則

- **從 merge base 讀取，不從 PR 的 head 讀取。** PR 修改 `.reviewer.json` 不會影響這次 review，而且修改本身是單向門（`POLICY_FILE_CHANGED`）。`codingstandards.md`（根目錄）同樣是 `POLICY_FILE_CHANGED`。
- 檔案不存在：使用預設值（PHP 啟用 `php-laravel` 與 `payments` preset、TypeScript / JavaScript 啟用 `node` preset、預設單向門、沒有專案規則）。
- 檔案存在但無效（JSON 錯誤、未知欄位、型別錯誤、無效的正規表示式、未知 preset、不是一般檔案）：**每個變更檔案都是 `FULL` + `POLICY_CONFIG_INVALID`**，而且 `POLICY_CONFIG_INVALID` 是單向門（專案規則沒有套用，必須人工確認）；錯誤細節在 JSON 報表的 `config.errors`。
- 設定只能新增攔截：沒有「忽略某個 fact」或「移除預設單向門」的語法。要減少誤報，只能讓 analyzer 的等價判定變強。
- 設定內容的 sha256 列在報表的 `config.digest`，並帶入規則引擎 interpreter 的版本（`config-rules@1.1.0+<digest 前 16 碼>`），所以設定不同時分析結果的 interpreter identity 也不同。

## 格式

```json
{
  "version": 1,
  "presets": ["php-laravel", "payments"],
  "rules": {
    "sensitiveOperands": [{ "pattern": "/wallet|balance|amount/i", "operators": "arithmetic" }],
    "protectedCalls": [{ "name": "verifySignature" }, { "receiver": "Gate", "name": "authorize" }],
    "protectedArguments": [{ "argument": "idempotencyKey", "blocker": "PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED" }],
    "sideEffectCalls": [{ "receiver": "Mail" }, { "name": "/^notify/" }],
    "protectedPaths": ["database/migrations/**", "config/payment.php"],
    "oneWayDoors": ["CONSTANT_VALUE_CHANGED"]
  }
}
```

除了 `version` 之外都可以省略。

| 欄位 | 說明 |
|---|---|
| `version` | 必須是 `1` |
| `presets` | 啟用的 preset。省略時為語言的預設值（PHP：`php-laravel`、`payments`；TypeScript / JavaScript：`node`）。可用的 preset：`php-laravel`（Laravel 的 transaction、授權、middleware、row lock、validation、model attributes、資料刪除；只適用 PHP）、`node`（Express / Koa / Fastify / NestJS、Prisma / TypeORM / Sequelize / knex / Mongoose、jsonwebtoken / jose、zod / joi / class-validator 的 transaction、row lock、授權、middleware、token 驗證、validation、資料刪除；只適用 TS / JS）、`payments`（具名參數 `idempotencyKey`、名稱像簽章驗證的 method 被移除；PHP 與 TS / JS）。不適用檔案語言的 preset 會被略過。注意：寫了 `presets` 就以它取代**所有語言**的預設值，例如物流專案寫 `["php-laravel"]` 就不套用 `payments` 的規則；PHP 與 TS 混合的 repo 要寫 `["php-laravel", "payments", "node"]` |
| `rules.sensitiveOperands` | `BINARY_OPERATOR_CHANGED` 的運算式（變更前或變更後）符合 `pattern` 時產生 `SENSITIVE_OPERAND_CHANGED`。`pattern` 必須是 `/regex/flags`；`operators` 為 `any`（預設）、`arithmetic`、`comparison` 或 `logical`，變更前或變更後的運算子屬於該類別才算 |
| `rules.protectedCalls` | 呼叫被移除（`CALL_REMOVED`）時產生 `PROTECTED_CALL_REMOVED` |
| `rules.sideEffectCalls` | 新增呼叫（`CALL_ADDED`）時產生 `SIDE_EFFECT_CALL_ADDED`，用於寄信、推播、排入 queue、呼叫外部付款 API 等不可逆的副作用 |
| `rules.protectedArguments` | 參數的值改變、被移除或被新增時產生 `PROTECTED_ARGUMENT_CHANGED`，或 `blocker` 指定的代碼（大寫英數與底線）。「改變」包括 `CALL_ARGUMENT_CHANGED` / `REMOVED` / `ADDED`、參數內的值變更（`charge(100)` → `charge(1000)` 的 `LITERAL_CHANGED`，以及 `VARIABLE_CHANGED`、`BINARY_OPERATOR_CHANGED`、`ARRAY_ITEM_*` 等 container 為該參數的 fact，含參數中巢狀陣列 / 物件的值），以及位置參數的順序改變（`CALL_ARGUMENTS_REORDERED`）。`argument` 是具名參數名稱（字串或 `/regex/`）或位置（從 0 開始的整數）；可加上 `name` / `receiver` 限定呼叫 |
| `rules.protectedPaths` | 符合的檔案有任何變更都產生 `PROTECTED_PATH`（包括只有排版變更、原本不需要 review 的檔案）。rename 時比對新舊兩個路徑 |
| `rules.oneWayDoors` | 加入單向門清單的原因代碼，例如 `CONSTANT_VALUE_CHANGED` |

### 呼叫的比對（`protectedCalls`、`sideEffectCalls`、`protectedArguments`）

規則比對 fact 的結構化 callee（見 [README「已實作」](../README.md#已實作)），同一條規則適用任何語言：

- `name`：method / function 名稱。
- `receiver`：呼叫對象。不含 `.` 時比對最後一段（`Gate` 同時符合 `Gate::authorize` 與 `\Illuminate\Support\Facades\Gate::authorize`）；含 `.` 時比對以 `.` 連接的完整路徑（`Illuminate.Support.Facades.Gate`）。PHP 的 `$this->inventory` 是 `this.inventory`，最後一段是 `inventory`。
- 字串為完全相等；`/regex/flags` 為正規表示式（一律比對名稱或最後一段）。
- `name` 與 `receiver` 至少要有一個。
- 鏈式呼叫中間的 call 沒有 receiver（`Mail::to($u)->send(...)` 的 `->send`），請比對鏈的開頭（`{ "receiver": "Mail" }` 符合 `Mail::to`）。
- TypeScript / JavaScript：`this.mailer.send(...)` 的 receiver 是 `this.mailer`（最後一段 `mailer`），`prisma.order.delete(...)` 是 `prisma.order`。JS 沒有具名參數，`protectedArguments` 的 `argument` 請寫位置；選項物件中的值改變（`charge({ idempotencyKey: k })`）算成該位置的參數改變，但無法以物件的 key 名稱指定。

### Glob

`protectedPaths` 使用 repository 相對路徑的 glob：`*` 不跨 `/`，`**` 可跨目錄（`**/` 也符合零層目錄），`?` 為單一字元。例如 `database/migrations/**`、`**/*.md`、`docs/*.md`。

## 單向門

規則產生的代碼都在預設單向門清單中（`SENSITIVE_OPERAND_CHANGED`、`PROTECTED_CALL_REMOVED`、`PROTECTED_ARGUMENT_CHANGED`、`SIDE_EFFECT_CALL_ADDED`、`PROTECTED_PATH`、`POLICY_FILE_CHANGED`、`POLICY_CONFIG_INVALID`），`protectedArguments` 自訂的 `blocker` 也自動加入。命中單向門的檔案路由為 `ESCALATED`（AI 審查後必須人工確認），見 [PR Review CLI「路由」](review-cli.md#路由三層審查)。

## 範例

金流專案：

```json
{
  "version": 1,
  "rules": {
    "sensitiveOperands": [{ "pattern": "/wallet|balance|amount/i" }],
    "sideEffectCalls": [{ "receiver": "PaymentGateway", "name": "charge" }],
    "protectedPaths": ["database/migrations/**", "config/payment.php"]
  }
}
```

物流專案（不套用金流規則）：

```json
{
  "version": 1,
  "presets": ["php-laravel"],
  "rules": {
    "sensitiveOperands": [{ "pattern": "/stock|inventory|qty/i" }],
    "protectedCalls": [{ "name": "reserveStock" }],
    "sideEffectCalls": [{ "receiver": "Mail" }, { "name": "dispatch" }]
  }
}
```
