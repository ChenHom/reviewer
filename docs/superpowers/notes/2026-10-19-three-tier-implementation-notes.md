# 三層審查架構實作紀錄（步驟 1–6）

對應設計：[三層審查架構設計](../specs/2026-10-18-three-tier-review-design.md) §8 的步驟 1–6。本文記錄實作時遇到的問題、採用的處理方式（依設計中的建議）與仍待決定的事項。

## 步驟 1：Fact schema v2

**做了什麼**：PHP analyzer 的 `callee` 改為 `{ text, name, receiver, kind, optional }`，`container` 改為 `{ type, keys, text, name?, callee?, argument? }`（`src/facts/structured.js`）。所有 interpreter 改比對結構化欄位（版本升為 `2.0.0`），adapter 版本 `0.1.0` → `0.2.0`。mutation evaluation 結果與修改前相同。

**問題與處理**：

1. **設計文件把兩件事混在一起。** §3.3 寫「`CALL_ARGUMENT_REMOVED` / `ADDED` 取代 `#index` 的 `CALL_ARGUMENT_CHANGED`」，但兩者描述不同的變更：`#index` 是「位置參數的值改變且無法被更細的 fact 解釋」，`REMOVED` / `ADDED` 是「參數數量改變」。處理：兩者都保留。`#index` 的 `argument` 改為數字（顯示仍為 `#0`）；參數數量改變原本一律是未解釋差異（`argument-count`），現在純移除或純新增時以 `CALL_ARGUMENT_REMOVED` / `ADDED` 解釋。
2. **`CALL_ARGUMENT_REMOVED` / `ADDED` 會讓部分檔案從 `FULL` 變成 `TARGETED`。** 決策仍是 `HUMAN_REVIEW_REQUIRED`，只有 fallback 改變，mutation corpus 沒有受影響的 case。之後的路由（步驟 3）中 `TARGETED` 可能進入 `AI_TRACK`，所以 middleware interpreter 同時加上「移除 `->middleware()` 參數」與「移除 `Route::group` 含 `'middleware'` 的設定參數」→ `MIDDLEWARE_GUARD_REMOVED`。不含 closure 的限制沿用 `#index` fallback 的規則。
3. **刻意保留的既有行為**（行為不變的重構，未順手修正）：
   - `$casts` / `$fillable` 等 property 只在 container 沒有巢狀 key 時才對應 blocker。`protected $casts = ['paid_at' => 'datetime']` 中某個 cast 改值時 container 是 `property:$casts[paid_at]`，目前是 `FACT_UNHANDLED`。
   - 條件反轉只在 container 為 `if` / `while` 等且沒有巢狀 key 時才是 `CONDITION_NEGATED`。
   - `Validator::make#1` 原本以 regex 前綴比對，會連 `#10`–`#19` 一起比對到；改為精確比對位置 `1`（`Validator::make` 只有 4 個參數，實務上沒有差別）。
4. **具名參數 container 的顯示文字改變**：原本是 `callee` 與參數名稱直接相接（`$gateway->chargeidempotencyKey`），改為 `$gateway->charge#idempotencyKey`。只影響顯示。
5. **class 層級 fact 的 `subject` 是檔案路徑**：property 預設值等不在 method 內的 fact，`subject` 是 `path`（既有行為），不是 class 名稱。步驟 6 的指紋因此對這類 fact 只能以檔案為範圍，見步驟 6。

## 步驟 2：拆分 interpreter 與語言查表

**做了什麼**：`src/interpreters/core.js`（語言層 7 個）、`presets/php-laravel.js`（框架 6 個）、`presets/payments.js`（業務 2 個）、`presets/index.js`（`resolveInterpreters(names)`）。`php-laravel-domain.js` 保留為相容入口，`PHP_LARAVEL_DOMAIN_INTERPRETERS` 成員不變。`src/review/review.js` 改用 `LANGUAGES` 依副檔名選 adapter 與 preset；`reviewRange` 的 `adapterOptions` 改為以語言 id 為 key（`{ php: { phpBinary } }`）。

**問題與處理**：

1. **語言層 interpreter 的 id 仍是 `php-` 前綴**（`php-operator-change` 等）。改 id 只會改變 `interpreterSetDigest`，但沒有實質好處，所以沿用原 id，在 `core.js` 註明它們是所有語言共用的。
2. **語言層並非完全與語言無關**：運算子集合以 PHP 為準（`<>`、`and` / `or` / `xor`），`PARAMETER_RENAMED` 的理由（PHP 8 named argument）在 JS 不成立。設計建議「依 fact 的 `language` 屬性選擇運算子集合」，但 TS 第 1 階段不輸出運算子 fact，所以先不加 `language` 屬性；集合外的運算子仍回傳 `OPERATOR_CHANGED`（仍是 blocker），不會漏判。留到 TS 第 3 階段處理。

## 步驟 3：路由

**做了什麼**：`src/routing.js`（`routeFile`、`summarizeTracks`、`DEFAULT_ONE_WAY_DOORS`）。CLI 報表每個檔案多了 `track` 與 `oneWayDoors`，頂層多了 `routing`；文字報表分成「需要人工確認（ESCALATED）」與「交給 AI 審查（AI_TRACK）」兩段，單向門標示「（單向門）」。新增 `--fail-on-escalation`。mutation evaluation 每個 case 記錄 `track`、以 `expectedTrack` 固定，並輸出 `Critical Escalation Rate`。

**問題與處理**：

1. **路由放在 `decision` 之外，而不是改寫 `decision`。** `decision` 維持第 1 層的語意（`HUMAN_REVIEW_REQUIRED` / `NOT_SELECTED_FOR_HUMAN_REVIEW`），路由另存在 `routing` 與 `files[].track`。這樣既有的 `--fail-on-review`、authority / Summary 流程都不受影響。
2. **預設設定下有 4 個 critical mutation 只會交給 AI**（Critical Escalation Rate 75%）：MUT-004（wallet `<` → `<=`）、MUT-012（扣款 `-` → `+`）、MUT-015（參數改名 + 合併變數）、MUT-016（合併變數）。前兩個是業務單向門，要靠專案設定的 `sensitiveOperands` 才能升級（步驟 4 以 case 層級的設定驗證）；後兩個是可回頭的變更，依設計交給 AI。這代表**採用路由後，Critical Recall 100% 只保證「需要 review」，不保證「人工會看到」**，人工會看到的比例要看 Critical Escalation Rate。
3. **`aiTrackPaths` 的適用範圍**：只有原因全部是 `FILE_ADDED`、`FILE_DELETED`、`UNSUPPORTED_FILE_TYPE` 的 `FULL` 檔案才能被交給 AI；analyzer 失敗、`COV-*`、binary、symlink、submodule、type change 不受影響。`FILE_DELETED` 列入是因為刪除測試或文件很常見；刪除 migration 等危險路徑應以 `protectedPaths` 保護（`protectedPaths` 優先）。
4. **PR 自我宣告的風險（`Merge-Risk`）沒有實作**：CLI 拿不到 PR 描述，屬於步驟 7（GitHub 整合）。
5. **`FILE_MODE_CHANGED`（例如加上執行權限）是 `AI_TRACK`**：它不在預設單向門清單中。專案可用 `oneWayDoors` 加入。

## 步驟 4：專案設定 `.reviewer.json`

**做了什麼**：`src/config/project-config.js`（`parseProjectConfig`、`createProjectPolicy`）、`src/config/matchers.js`（`/regex/` 與 glob）、`src/interpreters/config-rules.js`（規則引擎）、`src/review/git.js` 的 `readTreeFile`。`reviewRange` 從 merge base 讀設定，報表多了 `config`。新增原因代碼 `POLICY_CONFIG_INVALID`、`POLICY_FILE_CHANGED`、`PROTECTED_PATH`、`SENSITIVE_OPERAND_CHANGED`、`PROTECTED_CALL_REMOVED`、`PROTECTED_ARGUMENT_CHANGED`、`SIDE_EFFECT_CALL_ADDED`。mutation corpus 新增 MUT-017–020（case 可帶 `config`），全部 `ESCALATED`；Critical Escalation Rate 75% → 80%。說明文件：`docs/project-config.md`。

**問題與處理**：

1. **格式採 JSON**（使用者決定），不加 YAML 依賴。
2. **正規表示式的寫法**：設計文件的範例用 `(?i)...`，但 JavaScript 不支援這種內嵌旗標。改為 `/regex/flags` 字串；其他字串為完全相等。`sensitiveOperands.pattern` 只接受 `/regex/`。
3. **`receiver` 的完整路徑用 `.` 連接**：設計文件寫「需要精確比對時寫完整路徑」，但 PHP namespace 用 `\`、JSON 字串中要寫成 `\\`，容易出錯。改為含 `.` 時比對以 `.` 連接的完整路徑（`Illuminate.Support.Facades.Gate`），否則比對最後一段。
4. **寫了 `presets` 就取代預設值**：這是唯一能「減少」規則的設定（例如物流專案不套用 `payments`）。依設計，preset 是可選的業務層；設定檔本身從 merge base 讀、修改是單向門，所以移除 preset 需要人工確認。
5. **設定無效時仍以預設值分析**：讓報表照樣列出 fact，但每個檔案強制 `FULL` + `POLICY_CONFIG_INVALID`。
6. **`PROTECTED_PATH` 會讓 `NOT_SELECTED` 的檔案變成 `HUMAN_REVIEW_REQUIRED` / `TARGETED`**：設計說受保護路徑「任何變更都是單向門」；為了讓 `decision` 與路由一致，直接把決策改嚴格，而不是只改路由。
7. **鏈式呼叫的副作用規則要比對鏈的開頭**：`Mail::to($u)->send(...)` 中 `->send` 沒有 receiver（fact schema v2 的鏈式 call `receiver` 為 `null`）。文件說明以 `{ "receiver": "Mail" }` 比對 `Mail::to`。
8. **正規表示式的效能（ReDoS）**：設定來自 merge base（已審查過），沒有加逾時保護。
9. **`protectedArguments` 新增了 `PROTECTED_ARGUMENT_CHANGED`**：設計文件的單向門清單沒有它；已加入預設單向門，`blocker` 自訂的代碼也自動成為單向門。

## 步驟 5：TypeScript / JavaScript adapter（第 1 階段）

**做了什麼**：`analyzers/ts/`（TypeScript compiler API，`typescript` 鎖定 5.9.3，以子行程執行）、`src/adapters/typescript/adapter.js`（`typescript-v1@0.1.0`，obligation `COV-TS-001`）、`src/adapters/analyzer-process.js`（PHP / TS 共用的子行程執行）。`LANGUAGES` 加入 `ts`（`.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs`、`.cjs`，排除 `.d.ts`）。`npm run analyzer:install` 與 CI 都會安裝 `analyzers/ts` 的依賴；`npm run lint` 也檢查 `analyzers/ts`。mutation corpus 新增 3 個 safe、5 個 critical TS case（全部符合預期）。

**問題與處理**：

1. **TypeScript 版本**：npm 上最新是 7.x（原生移植版，JS API 不同），所以鎖定最後一個 JS 實作的穩定版 5.9.3。
2. **第 1 階段沒有 fact**：TS 的實質變更一律 `FULL` → `ESCALATED`，不會有 `TARGETED` / `AI_TRACK`，也不會命中專案規則（`.reviewer.json` 的規則要等第 2 階段輸出 call fact）。mutation 的 Critical Direct Fact Coverage 因此從 100% 降到 80%（5 個 TS critical case 是 fallback-only），這是預期的，不是退步。
3. **區域變數改名的範圍比設計文件更保守**：除了設計列的排除條件（`eval`、`with`、物件簡寫、export、class member），另外排除：
   - 參數（與 PHP 一致；`fn.toString()` 與部分 DI 框架看得到參數名稱）；
   - 會被賦予匿名 function / class / arrow 的變數（`const f = () => {}` 會讓 `f.name === 'f'`，改名會改變 `.name`）；
   - 解構簡寫 `const { a } = o`（改名會改變取用的 key）。
   - 有 direct `eval` 或 `with` 時整個檔案不做正規化（設計寫的是 scope 層級，但 `eval` 可以透過 closure 存取外層變數，以檔案為單位比較簡單也比較安全）。
4. **`fn.toString()` 的限制**：JavaScript 可以用 `Function.prototype.toString()` 讀到原始碼，所以理論上連排版變更都可觀察。與 PHP 接受反射的取捨相同，排版與註解仍視為等價，不另外處理。
5. **指示註解的位置是近似的**：以「註解文字 + 下一個 token 的文字」比較。同一個 `@ts-ignore` 移到另一個 token 前面會被視為不同（要求 review）；移到同名 token 前面則無法分辨。
6. **TypeScript parser 的文法錯誤也算 `TS_PARSE_ERROR`**：例如 `.js` 中的舊式八進位 `010` 會被 parser 回報為錯誤，因此該檔案為 `FULL`。寧可要求 review。
7. **字串與 template literal 不互相正規化**：`'a'` 與 `` `a` `` 在 tagged template 中語意不同，第 1 階段一律視為不同。
8. **real-repo evaluation 沒有 TS 版本**：產生器（`evaluation/real-repo/generate.php`）是 PHP 專用，TS 需要另寫，留待之後。
9. **執行環境**：本機（Node 22）與 CI（Node 24）都會跑 TS analyzer；TS analyzer 用執行 CLI 的同一個 Node（`process.execPath`）。
10. **測試時觀察到一次不穩定**：`tests/evaluation/real-repo-cli.test.js` 的「收到 SIGTERM 時移除 snapshot」在整個 suite 平行執行時失敗一次，單獨執行與重跑都通過。這個測試依賴時序，與本次變更無關；新增的 TS 測試讓 suite 的負載變高，可能更容易觸發。

## 步驟 6：Finding 指紋與局部 AST hash

**做了什麼**：PHP analyzer 新增 `ScopeHashes`：每個 fact 加上 `properties.scope = { kind, hash }`，為 head 版本中所屬 method / function 的 canonical AST hash（使用 head 的 scope-aware canonical 變數名稱）。`src/findings.js` 計算 finding（`id`、`subject`、`kind`、`blocker`、`anchor`、`ordinal`、`scopeHash`、`location`）。CLI 報表：`files[].contentHash`、`files[].findings`，以及 `facts[].subject` / `blockers` / `anchor` / `scopeHash`。

**問題與處理**：

1. **目前的 pipeline 不記錄「哪個 fact 產生哪個原因」**：`decision.reasons` 是彙總後的結果。處理：CLI 對每個 fact 單獨再跑一次 interpreter（`interpretSemanticFacts([fact], interpreters)`），結果放在 `facts[].blockers`。interpreter 是 deterministic 的，結果與彙總一致。
2. **`FULL` 的檔案也需要 finding**：設計寫「`ESCALATED` 但沒有 fact 的檔案」產生檔案層級 finding；但 `FULL` 檔案即使有 fact，也還有無法解釋的部分。處理：每個 `FULL` 檔案都有一個 `FULL_REVIEW` finding，綁定整個檔案的內容，檔案任何變動都會讓豁免失效。另外 `PROTECTED_PATH`、`POLICY_FILE_CHANGED` 這類不是來自 fact 的單向門也各有一個檔案層級 finding。
3. **整檔的 hash 使用 git blob id**（`contentHash`）：不需要另外讀檔計算；任何 byte 改變都會改變它。fact 的 scope 不存在時（method 在 head 中被刪除、不在 method 內）PHP analyzer 改用整個檔案的 canonical AST hash。
4. **anchor 中的運算式文字含變數名稱**：例如 `BINARY_OPERATOR_CHANGED` 的 anchor 含 `before` 運算式。之後若該處的區域變數改名，anchor 改變 → 舊 finding 變成「已修正」、新 finding 變成「待確認」，要求重新確認（保守）。scope hash 本身不受區域變數改名影響。
5. **class 層級的 fact 以整個檔案為 scope**：property 預設值（例如 `$fillable`）等 fact 的 `subject` 是檔案路徑（步驟 1 的第 5 點），因此 scope 是整個檔案的 hash，同一檔案的任何邏輯變更都會讓這類豁免失效（保守）。
6. **TS analyzer 沒有輸出 scope hash**：設計寫「PHP 與 TS analyzer 都輸出 scope hash」，但 TS 第 1 階段沒有 fact，per-fact 的 scope hash 沒有地方可放。處理：TS 檔案只有檔案層級的 `FULL_REVIEW` finding，綁定 `contentHash`；scope hash 與 TS 第 2 階段的 fact 一起實作。
7. **狀態（OPEN / FIXED / ACKNOWLEDGED / REOPENED）沒有在這一步實作**：依設計 §8，狀態機與 GitHub 留言中的狀態屬於步驟 7。這一步提供它需要的輸入（穩定的 finding id 與 scope hash），並以測試驗證：上方插入程式碼與區域變數改名後 id 與 scope hash 不變、同一 method 的邏輯改變時 id 不變但 scope hash 改變、加回被移除的呼叫後 finding 消失、同一 method 中兩個相同的移除產生兩個 finding。

## 跨步驟的注意事項

1. **real-repo evaluation 的 `compare`**：`--baseline-ref` 指向 fact schema v2 之前的 commit 時，每筆有 fact 的結果在 `facts` 欄位都會不同（`callee` / `container` 的形狀改變，且多了 `properties.scope`）。這是預期的；比較時請看 `decision`、`fallback`、`reasons` 與 gate。`evaluation/real-repo/run.js` 以 baseline snapshot 自己的 `PHP_LARAVEL_DOMAIN_INTERPRETERS` 執行，所以保留了這個相容入口。
2. **real-repo evaluation 沒有在本機重跑**：目標專案不在 repo 內（見 `docs/current-state.md`）。步驟 1、2 是行為不變的重構，mutation corpus 結果相同；但 `CALL_ARGUMENT_REMOVED` / `ADDED` 會讓部分真實檔案從 `FULL` 變成 `TARGETED`，建議合併前在本機對目標專案執行 `npm run eval:real-repo -- evaluate --baseline-ref <修改前>`，確認 `RISKY_REDUCED` 仍為 0。
3. **尚未實作**（設計 §8 步驟 7–9）：GitHub 留言中的狀態與 ack 指令、置頂儀表板、Check、PR 自我宣告的風險、TS 第 2 / 3 階段、第 2 層 AI、retro。
4. **待決事項**（設計 §9）中仍未決定的：`FULL` 中「未分析」檔案的預設路由（目前依建議為 `ESCALATED`，可用 `aiTrackPaths` 放寬）、AI 是否直接 commit、豁免權限、TS 型別變更的路由。
