# 三層審查架構實作紀錄（步驟 1–6、8、9）

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
5. **指示註解的位置是近似的**：以「註解文字 + 下一個 token 的文字」比較。同一個 `@ts-ignore` 移到另一個 token 前面會被視為不同（要求 review）；移到同名 token 前面則無法分辨。（PR #8 的 review 指出這是 fail-open，已修正，見「PR #8 review 的修正」。）
6. **TypeScript parser 的文法錯誤也算 `TS_PARSE_ERROR`**：例如 `.js` 中的舊式八進位 `010` 會被 parser 回報為錯誤，因此該檔案為 `FULL`。寧可要求 review。
7. **字串與 template literal 不互相正規化**：`'a'` 與 `` `a` `` 在 tagged template 中語意不同，第 1 階段一律視為不同。
8. **real-repo evaluation 沒有 TS 版本**：產生器（`evaluation/real-repo/generate.php`）是 PHP 專用，TS 需要另寫，留待之後。
9. **執行環境**：本機（Node 22）與 CI（Node 24）都會跑 TS analyzer；TS analyzer 用執行 CLI 的同一個 Node（`process.execPath`）。
10. **測試時觀察到一次不穩定**：`tests/evaluation/real-repo-cli.test.js` 的「收到 SIGTERM 時移除 snapshot」在整個 suite 平行執行時失敗一次，單獨執行與重跑都通過。這個測試依賴時序，與本次變更無關；新增的 TS 測試讓 suite 的負載變高，可能更容易觸發。步驟 8 時同一個檔案的「prepareBaseline 從 git ref 建立可執行的 snapshot」也在整個 suite 平行執行時失敗一次，單獨執行與重跑都通過。

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

## 步驟 8：TypeScript / JavaScript adapter 第 2、3 階段與 `node` preset

**做了什麼**：

- TS analyzer：`analyzers/ts/src/syntax.js`（結構化 callee、subject、字面值判斷、UTF-8 byte offset）、`calls.js`（呼叫的擷取與 `CALL_REMOVED` / `CALL_ADDED`）、`structural-diff.js`（與 PHP `StructuralDiff` 相同的結構比對，產生其餘 facts 與 decorator 的 `ANNOTATION_*`）、`scope-hashes.js`（每個 fact 的 `properties.scope`，`ts:` 前綴）。`analyze.js` 以三次比較判定：原始名稱、scope-aware canonical 名稱、原始名稱加上 `VARIABLE_CHANGED`。指示註解從 `COV-TS-001:DIRECTIVE_COMMENT_CHANGED` 改為 `DIRECTIVE_COMMENT_CHANGED` fact。adapter 版本 `typescript-v1@0.2.0`。
- 語言層新增 `core-annotation`（`ANNOTATION_REMOVED` / `ANNOTATION_ADDED`）與 `core-directive-comment`（`DIRECTIVE_COMMENT_CHANGED`）。
- `src/interpreters/presets/node.js`：transaction、row lock、授權、middleware、token / 簽章驗證、validation、資料刪除共 7 個 interpreter；TS / JS 預設啟用 `node`。`php-laravel` 新增 `laravel-data-deletion`。`DATA_DELETION_ADDED` 原本已在預設單向門中但沒有任何 interpreter 產生，現在 PHP 與 TS 都會產生。
- mutation corpus：重新釘住 4 個既有 TS case（3 個改由 fact 偵測，其中 2 個變成 `ESCALATED`），新增 10 個 TS critical case（含 2 個帶 `.reviewer.json` 的 case，驗證專案規則也適用於 TS）與 1 個 TS safe case。43 個 case 全部符合預期：Critical Recall 100%、Safe Reduction 100%、Critical Direct Fact Coverage 97.1%、Critical Escalation Rate 77.1%。

**問題與處理**：

1. **第 2、3 階段一起實作**：設計把「呼叫 / decorator facts」與「其餘詞彙」分成兩個階段，但兩者來自同一個結構比對（與 PHP 相同），分開做只會重工。兩個階段的 gate（該語言 Critical Recall 100%、False Negative 0）都以同一份 mutation corpus 驗證。
2. **寧可不解釋的地方**（都會讓檔案為 `FULL`，交給 AI）：property key 改變（不以字面值變更解釋）、物件簡寫與解構的 key、modifier 增減（`static`、`async`）、node flags 或運算子以外的純量欄位不同、子節點比較找不到差異但 canonical hash 不同（`hash-only`）、`new Date` ↔ `new Date()`（等價，但 canonical 形式不同）。位置參數的 `CALL_ARGUMENT_CHANGED` 與 PHP 相同，只標示位置、不視為已解釋。
3. **沒有 NodeArray 與空的 NodeArray 視為相同**：`@Transactional() m()` → `m()` 時 after 的 `modifiers` 是 `undefined`。原本一邊缺欄位一律未解釋，導致「只移除一個 decorator」無法產生 `ANNOTATION_REMOVED`；改成把缺少的 NodeArray 當成空 list 比較（list 中無法解釋的增減照樣未解釋）。
4. **`DIRECTIVE_COMMENT_CHANGED` 不是單向門**：`@ts-ignore` 會隱藏型別錯誤，但不是做了就難以回頭的變更；改成 fact 後路由為 `AI_TRACK`（原本是 `FULL` → `AI_TRACK`，路由不變）。需要的專案可以把它加進 `rules.oneWayDoors`。
5. **`new` 不產生呼叫 fact**（與 PHP 相同）：`new Error(...)` 出現在被移除的 guard 中會產生雜訊。`new ValidationPipe({ whitelist: true })` 的參數變更仍以 container（callee `kind: constructor`）表示。
6. **JS 沒有具名參數**：`payments` 的 `idempotencyKey` 規則與 `.reviewer.json` 的具名 `protectedArguments` 對 TS 無效；選項物件中的值改變是 `LITERAL_CHANGED` 等 fact（container 的 `keys` 含 `idempotencyKey`）。暫不擴充規則語法，記在 `docs/project-config.md`；TS 的預設 preset 只有 `node`（`node` 已包含簽章驗證名稱的規則）。
7. **名稱判斷是啟發式的**：Node 生態沒有 Laravel facade 這種固定名稱，`node` preset 以 receiver 名稱判斷（`app` / `router` / `*Router` 是路由、`prisma` / `*Repository` / `*Model` 是資料庫）。命名不同時不會命中，fact 照樣以 `FACT_UNHANDLED` 交給 AI；反過來也可能誤判成單向門（例如非 ORM class 的 `User.destroy`、名為 `*Table` 的雜湊表的 `delete`）。取捨是寧可多送人工；`axios.post`、`api.post`、`map.delete`、`socket.destroy`、Sentry 的 transaction、`{ session: false }`、巢狀的 `where: { lock: 1 }` 都有測試確認不會誤判。
8. **鏈的中段沒有 receiver**：`z.number().min(1)` 的 `.min` 無法知道鏈的開頭是 `z`。只把不常出現在一般鏈式呼叫的規則名稱（`min`、`optional`、`email`…）視為 schema 規則，`trim`、`includes`、`startsWith` 等字串 / 陣列 method 不列入。`VALIDATION_RULE_CHANGED` 不是單向門，誤標的代價只是標籤不準。
9. **subject 的寫法**：TS 為 `Class.method`（PHP 為 `Class::method`）；指派給變數 / property 的匿名 function 以該名稱為 subject。`php-laravel` 中依 subject 判斷的規則（`rules()`、`casts()`）只適用 PHP。
10. **`presets` 取代所有語言的預設值**：寫了 `"presets": ["php-laravel"]` 的 PHP + TS 混合 repo 不會套用 `node`。維持「寫了就取代」的單純規則，在文件中提醒混合 repo 要列出 `node`。
11. **PHP 的 interpreter set 也改變了**（語言層多 2 個、`php-laravel` 多 1 個）：`interpreterSetDigest` 不同，既有 PHP mutation case 的決策不變。real-repo evaluation 無法在本機重跑（目標專案不在 repo 內），建議合併前以 `--baseline-ref` 重跑，確認 `RISKY_REDUCED` 仍為 0。
12. **未解釋的檔案也會套用 fact 的單向門**：`@Roles(Role.Admin)` → `@Roles(Role.User)` 是 property access 的改變，無法解釋（`FULL`），但 fallback 的 `CALL_ARGUMENT_CHANGED` 仍會讓 `node` preset 產生 `AUTHORIZATION_ABILITY_CHANGED` → `ESCALATED`。
13. **Laravel 的一般 `->delete()` 不算資料刪除**（可能是 soft delete），`DB::table('x')->delete()` 這種鏈也偵測不到（鏈的中段沒有 receiver），交給 AI。
14. **real-repo evaluation 仍沒有 TS 版本**（步驟 5 的第 8 點）。

## 步驟 9a：第 2 層 AI 審查

**做了什麼**：`src/ai/`（`client.js`：Anthropic Messages API；`prompt.js`：system / user prompt 與標籤跳脫；`schema.js`：structured outputs 的 JSON schema 與驗證；`review.js`：`runAiReview()`、套用修正、`needsHuman` / `summarizeHuman`）。`reviewRange()` 新增 `ai` 選項；報表新增 `ai`、`human`、`files[].ai`、`files[].needsHuman`；`src/findings.js` 新增 `aiFindingsFor()`（`kind: AI`）。CLI 新增 `--ai`、`--ai-model`、`--ai-effort`、`--ai-apply`、`--ai-concurrency`、`--ai-max-files`、`--fail-on-human`；文字報表在 AI 審查後改為「需要人工確認」「AI 已修正」「AI 審查通過」三段。

**問題與處理**：

1. **環境中沒有 API 憑證**：無法對真實 API 做 smoke test。以假的 client 驗證請求格式（model、`betas`、`fallbacks: "default"`、`output_config` 的 effort 與 JSON schema、system 的 prompt cache）與所有分支；參數名稱與型別對照 `@anthropic-ai/sdk` 0.131.0 的型別定義。建議第一次使用時先手動執行 `ANTHROPIC_API_KEY=… node bin/review.js --base <ref> --ai` 確認。
2. **runtime 依賴**：設計 §3.5 寫「Reviewer 主套件維持沒有 runtime dependency」。AI 層需要官方 SDK（`@anthropic-ai/sdk`，鎖定 0.131.0），處理方式是只在 `--ai` 時動態載入：機械審查仍不需要 `npm install`，沒有安裝時 `--ai` 以 `AI_SDK_MISSING` 結束。
3. **每個檔案一個請求**，而不是整個 PR 一個請求：失敗互不影響、可以並行、單一請求的大小可控；共同的 system prompt（審查規則 + `codingstandards.md`）以 prompt cache 重用。代價是 AI 看不到其他檔案的變更（記為限制）。
4. **「已修正」的語意**：設計建議 `AI_TRACK` 預設直接 commit，但「AI 是否直接 commit」仍是待決事項。處理：`--ai-apply` 只寫入 worktree、不 commit；`FIXED` 的檔案不算需要人工，但列在 `human.pendingFixes`，`--fail-on-human` 在 commit 並重新 review 之前會失敗。要不要讓 CI 自動 commit，留到步驟 7（GitHub 整合）與使用者決定。
5. **修正的格式用「唯一字串替換」而不是 unified diff**：模型產生的 hunk header 常有誤差；`oldText` 必須在 head 中恰好出現一次，可以精確驗證。修正後的內容再交給同一套機械審查，命中單向門時不套用，所以 AI 的修正不會在 worktree 中偷偷加入單向門。
6. **單向門檔案的 FIX 一律不套用**，變成建議；AI 在單向門檔案上的意見（含 PASS）不影響「需要人工」。
7. **一致性規則**：AI 回答 PASS 但同時列出 `high` 疑慮時視為 NEEDS_HUMAN；FIX 同時有 `high` 疑慮時不套用。
8. **AI finding 的 id 不穩定**：AI 的輸出不是 deterministic 的，同一個問題的標題在重跑時可能不同。`scopeHash` 一律綁定 `contentHash`（檔案任何改變都讓豁免失效）。步驟 7 的狀態機需要對 `kind: AI` 的 finding 另外處理（例如不以 id 比對，而是「檔案內容未變時沿用上次的人工確認」）。
9. **輸入上限**：單一檔案 200,000 字元。diff 超過時不截斷，直接視為 AI 失敗；完整內容放不下時只送 diff 並明確告知 AI。binary 不送。超過 `--ai-max-files` 的檔案也視為失敗。
10. **Prompt injection**：PR 的內容放在標籤中並跳脫同名標籤；system prompt 要求把試圖影響審查的文字列為 `high` 疑慮並回答 NEEDS_HUMAN。即使被誤導，最壞的結果是一個 `AI_TRACK` 檔案被放行，單向門不受影響。
11. **設定錯誤與執行失敗分開處理**：沒有 API key、沒有安裝 SDK、effort 無效、`--ai-apply` 的 worktree 不符 → exit code 2（在分析與呼叫 API 之前）；個別檔案的 API 錯誤、拒絕、輸出截斷或格式錯誤 → 該檔案 `FAILED`，需要人工。
12. **模型與參數**：模型預設 `claude-opus-5-5`，effort 預設 `high`（明確設定；這個模型 thinking 一律開啟，不傳 `thinking`）；`max_tokens` 32,000 並以 streaming 取得完整回應。預設啟用 server-side fallback（`fallbacks: "default"`），由備援模型回答的檔案在報表中標示；這個參數只在 Claude API 可用。
13. **輸出語言固定為繁體中文**（寫在 system prompt），目前不能設定。
14. **沒有 `--ai` 時**，`human.required` 把 `AI_TRACK` 也算進去（沒有人看過）。因此 `--fail-on-human` 不加 `--ai` 時等同 `--fail-on-review`。

## 步驟 9b：Retro

**做了什麼**：`bin/retro.js` 與 `src/retro/`（`metrics.js`、`proposals.js`、`format.js`），文件 `docs/retro.md`。`src/review/review.js` 拆出 `analysisContext()` 與 `reviewSources()`（AI 修正的檢查與 mutation case 草案的驗證共用）；`src/ai/client.js` 的 `review()` 可以指定輸出的 schema 與驗證。

**問題與處理**：

1. **輸入來源**：設計 §7 寫「透過 API 讀取各 PR 的狀態留言、ack 理由與人工 review comment」，這些要等步驟 7 的 GitHub 整合。處理：retro 讀 `bin/review.js --out` 的 JSON 報表（CI 可以存成 artifact），人工留言以 JSON Lines 檔案輸入（格式見 `docs/retro.md`，之後由步驟 7 從 GitHub 匯出）。豁免率、REOPENED 次數、宣告與偵測不一致列為不可用。
2. **「以 PR 提出」**：開 PR 屬於步驟 7。處理：retro 只輸出草案（`retro.md`、`reviewer.proposed.json`、`mutation-drafts.json`），不修改任何檔案。
3. **規則必須先有通過的 mutation case**（設計 §7 第 2 點）：retro 以「加入建議規則後的設定」對每個草案執行同一套機械審查，標示是否產生預期的原因代碼；但「搬進 `cases.json` 並通過 `npm run eval:mutations`」仍由人執行。
4. **AI 提出的規則以字串（JSON 文字）表示**：structured outputs 的 schema 不方便表達每個 section 不同形狀的物件；收到後 parse 並以 `parseProjectConfig()` 逐條驗證，無效的不採用。
5. **「從未被引用」只看 AI 疑慮的 `standard` 欄位**：AI 沒有引用不代表規範沒用（例如 AI 因為規範而回答 PASS），報告中只列為精簡的候選。
6. **`.yaml` → `.json`**：設計 §7 寫 `.reviewer.yaml`，實作沿用步驟 4 決定的 `.reviewer.json`。
7. **同一個 head 的報表只算一次**（重跑時保留最後一份）；報表沒有 PR 編號，以 repository + head SHA 區分。

## PR #8 review 的修正（Codex review，commit `1275769` 之後）

1. **`protectedArguments` 漏掉參數內的值變更**（P1，確認為真）：analyzer 只在沒有更細的 fact 時才輸出 `CALL_ARGUMENT_CHANGED`，所以 `charge(100)` → `charge(1000)` 是 `LITERAL_CHANGED`（container 為 `charge#0`），規則引擎沒有比對，結果是 `FACT_UNHANDLED`（`AI_TRACK`），設定的單向門沒有生效。TS 與 PHP 都重現。修正：
   - 規則引擎也比對 container 為該參數（`type: argument`，含巢狀 key）的 fact，以及位置參數的 `CALL_ARGUMENTS_REORDERED`；`BINARY_OPERATOR_CHANGED` 不再提前 return，可以同時產生 `SENSITIVE_OPERAND_CHANGED` 與 `PROTECTED_ARGUMENT_CHANGED`。規則引擎版本 `1.1.0`。
   - PHP 與 TS analyzer 的 `BINARY_OPERATOR_CHANGED` 加上 `container`（原本沒有，運算子改變無法對應到參數）。adapter 版本改為 `0.3.0`。
   - 新增 MUT-TS-016（帶 `protectedArguments` 的位置參數字面值改變 → `ESCALATED`）。
   - 限制：container 是最近的一層呼叫，`charge(f(a + 1))` 中的運算子改變對應到 `f#0`，不會對應到 `charge#0`。
2. **指示註解移到文字相同的 token 前面時沒有 fact**（P1，確認為真）：`// @ts-ignore` 從第一個 `foo(1)` 移到 `foo(2)` 前面，key 都是 `// @ts-ignore@foo`，AST 相同，結果是 `COMPLETE` 沒有 fact → `AUTO_PASS`（fail-open）。修正：key 加上「同樣文字的 token 中第幾個」；前面新增或刪除同樣文字的 token 也會讓編號改變，這時多產生 fact（保守）。
3. **AI 回答 PASS 卻附上修正時被放行**（P1，確認為真）：schema 允許這種組合，原本記為 `PASS`、修正被丟掉，文字報表的「通過」段落也不顯示修正，`--fail-on-human` 會通過。修正：PASS + 非空的 `fix.edits` 照 FIX 處理（有 `--ai-apply` 且通過檢查時套用，否則交給人工並附上修正建議）。
4. **ESLint 的其他 inline 設定沒有追蹤**（P2，確認為真）：只新增 `/* eslint no-eval: "off" */` 或 `/* global foo */` 時 AST 相同，檔案為 `AUTO_PASS`，但 CI 的 lint 結果會改變。修正：block comment 開頭為 `eslint`、`eslint-env`、`global(s)`、`exported` 時視為指示註解（一般文字提到 eslint 不算）；順便加入同類的 `biome-ignore`、`oxlint-disable` / `enable`、`deno-lint-ignore`。
5. **CI 偶發失敗的根本原因**（`tests/evaluation/real-repo-cli.test.js` 的「prepareBaseline 從 git ref 建立可執行的 snapshot」，`ERR_STREAM_PREMATURE_CLOSE`）：`prepareBaseline()` 以 `stream.pipeline(gitArchive.stdout, tar.stdin)` 轉接。tar 讀完 archive 就成功結束，Node 隨即 destroy tar 的 stdin；若這時 git 那端的 EOF 還沒送到 Node，pipeline 會把成功的解壓縮誤判為 premature close。本機以 8 個並行重現 200 次中 4 次（git 與 tar 都 exit 0）。這段程式碼在 master 上就有，這個 PR 讓 test suite 的負載變高而更容易觸發。修正：tar 直接以 `git archive` 的 stdout 作為 stdin（OS 層的 pipe，不經過 Node 的 stream），父行程關閉自己的讀取端（tar 提早失敗時 git 會收到 EPIPE，不會卡住）；同樣的壓力測試 400 次 0 失敗。步驟 5 第 10 點記錄的不穩定（同一個檔案）也可能是同一類時序問題，之後若再出現請另外追查。

## 跨步驟的注意事項

1. **real-repo evaluation 的 `compare`**：`--baseline-ref` 指向 fact schema v2 之前的 commit 時，每筆有 fact 的結果在 `facts` 欄位都會不同（`callee` / `container` 的形狀改變，且多了 `properties.scope`）。這是預期的；比較時請看 `decision`、`fallback`、`reasons` 與 gate。`evaluation/real-repo/run.js` 以 baseline snapshot 自己的 `PHP_LARAVEL_DOMAIN_INTERPRETERS` 執行，所以保留了這個相容入口。
2. **real-repo evaluation 沒有在本機重跑**：目標專案不在 repo 內（見 `docs/current-state.md`）。步驟 1、2 是行為不變的重構，mutation corpus 結果相同；但 `CALL_ARGUMENT_REMOVED` / `ADDED` 會讓部分真實檔案從 `FULL` 變成 `TARGETED`，建議合併前在本機對目標專案執行 `npm run eval:real-repo -- evaluate --baseline-ref <修改前>`，確認 `RISKY_REDUCED` 仍為 0。
3. **尚未實作**（設計 §8 步驟 7）：GitHub 留言中的狀態與 ack 指令、置頂儀表板、Check、PR 自我宣告的風險。使用者決定步驟 7 最後處理，先完成步驟 8、9。
4. **待決事項**（設計 §9）中仍未決定的：`FULL` 中「未分析」檔案的預設路由（目前依建議為 `ESCALATED`，可用 `aiTrackPaths` 放寬）、AI 是否直接 commit、豁免權限、TS 型別變更的路由。

## 流程調整（2026-10-19，步驟 1–6 完成後）

使用者確認核心流程是串接的：**機械審查 → AI 審查剩下的 → AI 審查後需要人工處理、確認的才交給人工**。原本的設計是「單向門或 `FULL` 直接交給人工、AI 不審查」，與這個流程不同。兩個安全取捨由使用者決定：

1. **單向門：AI 審查後一律交給人工**，AI 不能放行（建議選項）。
2. **`FULL`（無法解釋、analyzer 失敗、沒有分析）：交給 AI，由 AI 決定是否需要人工**（建議選項）。

**改了什麼**：

- `src/routing.js`：`ESCALATED` 只看單向門；`FULL` 沒有單向門時為 `AI_TRACK`。`POLICY_CONFIG_INVALID` 加入預設單向門（設定無效時專案的單向門規則沒有套用，必須人工確認）。
- 移除 `.reviewer.json` 的 `routing.aiTrackPaths`：沒有分析的檔案本來就交給 AI，這個設定不再需要。舊設定若寫了 `routing` 會被判為無效（`POLICY_CONFIG_KEY_UNKNOWN:routing`）。
- `src/findings.js`：finding 只代表必須人工確認的單向門；移除 `FULL_REVIEW`（無法解釋的部分交給 AI）。AI 判斷需要人工的項目將以 `kind: AI` 的 finding 加入（步驟 9）。
- 文字報表的兩段改為「AI 審查後必須人工確認（ESCALATED，單向門）」與「交給 AI 審查，由 AI 判斷是否需要人工（AI_TRACK）」。
- 設計文件 §1 的原則 1 改為「單向門只有人能放行」，§2、§6 依新流程改寫。

**影響**：

- mutation 的 Critical Escalation Rate 從 84% 降到 64%：5 個 TS critical case（移除 Prisma transaction、移除 Express `requireAuth`、加上 `@ts-ignore`、物件簡寫 key 改變、optional chain 加括號）現在是 `AI_TRACK`。TS 第 1 階段偵測不到單向門，這些是否交給人工完全依賴 AI 審查。PHP 的 4 個 case（MUT-004、012、015、016）同樣依賴 AI（或專案設定的 `sensitiveOperands`）。
- **AI 審查層實作前，`AI_TRACK` 沒有任何人或 AI 看。** 在 AI 層完成之前，CI 若要守住安全，應繼續使用 `--fail-on-review`（任何需要 review 的變更都失敗），而不是只用 `--fail-on-escalation`。
- AI 呼叫失敗或逾時時，該檔案的 AI 結果視為「需要人工」（設計 §6），在步驟 9 實作。
