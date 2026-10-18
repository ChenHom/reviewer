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
