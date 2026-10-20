# 二次 review 狀態（`bin/review-state.js`）

三層審查中「人工確認」那一層的狀態追蹤：哪些單向門或 AI 疑慮已經有人看過並確認、確認後程式碼有沒有又改、哪些已經修正。設計見 [三層審查架構設計](superpowers/specs/2026-10-18-three-tier-review-design.md) §4、§5；實作過程與取捨見[實作紀錄](superpowers/notes/2026-10-19-three-tier-implementation-notes.md)「步驟 7a」。

這是設計 §8 步驟 7 的 **CLI 部分（7a）**：輸入 `bin/review.js --out` 的報表、上一版儀表板留言、PR 的留言與留言者權限，輸出新的置頂儀表板、Check 結論、確認指令的回覆與行內 thread 的目標狀態。**它不呼叫任何 GitHub API**；讀取留言與權限、寫回留言、thread 與 Check 是之後的 GitHub 部分（7b，workflow）。

實作位置：

- `bin/review-state.js`：參數解析與輸出。
- `src/review-state/index.js`：`updateReviewState()`，串起下面幾個模組。
- `src/review-state/machine.js`：追蹤的項目（`buildItems()`）、狀態機（`computeState()`）、Check（`checkResult()`）。
- `src/review-state/commands.js`：確認指令的解析與驗證。
- `src/review-state/codec.js`：狀態的編碼、HMAC 簽章與驗證。
- `src/review-state/dashboard.js`：儀表板 Markdown、長度上限處理、行內 thread 的目標狀態。
- 測試：`tests/review-state/`（含以真實 git repo 與報表執行 CLI 的端對端測試）。

## 用法

```bash
# 1. 機械審查（與 AI 審查）產生報表
node bin/review.js --repo . --base origin/main --head "$HEAD_SHA" --ai --out report.json

# 2. 重算狀態（workflow 先以 GitHub API 取得 PR、儀表板留言（含 GraphQL 的 editor）、留言與權限）
REVIEWER_STATE_KEY="$KEY" node bin/review-state.js \
  --report report.json --pr pr.json \
  --dashboard dashboard.json --comments comments.json --permissions permissions.json \
  --out state.json --fail-on-pending

# 3. workflow 依 state.json 更新儀表板留言、回覆確認指令、開或 resolve thread、建立 Check（7b）
```

本機預覽（沒有 key，狀態不簽章，下次執行不會採用）：

```bash
echo '{"number": 1, "user": {"login": "me"}}' > pr.json
node bin/review-state.js --report report.json --pr pr.json --unsigned
```

| 選項 | 說明 |
|---|---|
| `--report <file>` | 必填。目前 head 的報表（`bin/review.js --out`）。確認要綁定的欄位必須齊全：`config.digest`（沒有 `.reviewer.json` 時為 `null`）、有 AI 審查時的 `ai.standards.digest`（沒有 `codingstandards.md` 時為 `null`），每個檔案的 `contentHash`、每個單向門 finding 的 `id`、`blocker`、`policyDigest`（`scopeHash` 可以是 `null`，這時以 `contentHash` 綁定）。缺少時以 `REVIEW_STATE_REPORT_INVALID:<原因>` 結束：無法判斷程式碼或規則有沒有改變 |
| `--pr <file>` | 必填。PR，GitHub REST 的 pull request JSON（使用 `number`、`user.login`、`head.sha`）。`head.sha` 與報表的 head 不同時以 `REVIEW_STATE_STALE_REPORT` 結束：舊的報表晚到時不能拿來更新狀態或 Check |
| `--dashboard <file>` | 上一版儀表板留言：GitHub REST 的 comment JSON（使用 `body`、`user.login`、`user.type`），加上 GraphQL 的 `editor`（最後一次編輯的人；沒有編輯過為 `null`）。保存的狀態只在留言的作者是 bot、而且 `editor` 為 `null` 或 bot 自己時採用（見「狀態的保存」）；只有純文字內容時不採用，改從確認留言重播。第一次執行時省略 |
| `--comments <file>` | PR 的**全部** issue comments，GitHub REST 的 JSON 陣列（使用 `id`、`body`、`user.login`、`user.id`、`user.type`、`created_at`、`updated_at`）。保存的確認每次都與它核對，缺少的留言視為已刪除；缺少 `created_at` 或 `updated_at` 的留言無法偵測編輯，其中的確認不採用 |
| `--permissions <file>` | 留言者目前的權限：`{ "<login>": "<權限>" }`，值為 `admin`、`maintain`、`write`、`triage`、`read`、`none`，或 GitHub collaborator permission API 的 `{ role_name, permission }`（`role_name` 是自訂角色時改用 `permission` 的標準權限）。沒有列出或不認得的權限，確認一律不採用；之前接受的確認也每次重新檢查，所以要涵蓋所有確認者 |
| `--history <path>` | 之前 head 的報表（檔案或目錄，目錄中所有 `.json`）；可重複。只在狀態無法驗證時用來驗證確認指令的 `@head`（見「狀態的保存」）。無法解析的檔案在 stderr 警告後略過；欄位不齊全的報表（同 `--report` 的條件）不用來驗證 |
| `--ack-permission <level>` | 確認所需的最低權限：`write`（預設）、`maintain`、`admin` |
| `--out <file>` | 寫出完整結果（JSON，見「輸出」） |
| `--json` | stdout 輸出完整結果（取代儀表板 Markdown） |
| `--fail-on-pending` | 有待確認的項目（Check 為 `failure`）時 exit code 1 |
| `--unsigned` | 沒有 `REVIEWER_STATE_KEY` 時仍執行：狀態不簽章（`kid=unsigned`），只供本機預覽 |

| 環境變數 | 說明 |
|---|---|
| `REVIEWER_STATE_KEY` | 狀態的 HMAC key。必填，除非 `--unsigned`。key 本身不會出現在留言中（留言只有 key 的 sha256 前 8 碼） |
| `REVIEWER_STATE_PREVIOUS_KEYS` | 換 key 後仍可驗證舊狀態的 key，以換行或逗號分隔。寫出時一律使用 `REVIEWER_STATE_KEY` |

exit code：0 完成；1 有待確認的項目（`--fail-on-pending`）；2 錯誤（stderr 印出 `error: <訊息>`）。錯誤代碼：`OPTION_MISSING:--report`、`OPTION_MISSING:--pr`、`OPTION_INVALID:--ack-permission=<值>`、`REVIEW_STATE_KEY_MISSING`、`REVIEW_STATE_STALE_REPORT:<報表 head>≠<PR head>`、`REVIEW_STATE_REPORT_INVALID:<原因>`（`REPORT_SHAPE_INVALID`、`CONFIG_DIGEST_MISSING`、`AI_STANDARDS_DIGEST_MISSING`、`AI_SUMMARY_MISSING`、`FILE_PATH_MISSING`、`FILE_CONTENT_HASH_MISSING:<path>`、`FINDING_INVALID:<path>`、`FINDING_POLICY_DIGEST_MISSING:<path>`、`FINDING_SCOPE_HASH_INVALID:<path>`）、`REVIEW_STATE_PR_INVALID`、`REVIEW_STATE_COMMENTS_INVALID`、`REVIEW_STATE_*_NOT_JSON:<path>`。

## 追蹤的項目

| 種類 | 來源 | 確認綁定 |
|---|---|---|
| 🚪 單向門（`DOOR`） | 報表 `files[].findings` 中機械審查的 finding（`kind` 不是 `AI`），每個 finding 一項 | finding 的 `scopeHash`（所屬 method / function 的局部 AST hash；檔案層級或沒有 scope 時為檔案內容）與 `policyDigest`（產生這個原因的 interpreter 或專案設定） |
| 🤖 檔案層級（`FILE`） | 每個檔案一項：AI 的 finding（`AI_CONCERN`、`AI_NEEDS_HUMAN`、`AI_REVIEW_FAILED`）；沒有單向門、又不確定不需要人工的檔案；以及有單向門、但 AI 沒有放行單向門以外部分的檔案（沒有 AI 結果時為 `AI_REVIEW_MISSING`，AI 失敗為 `AI_REVIEW_FAILED`，AI 判斷需要人工為 `AI_NEEDS_HUMAN`，`--ai-apply` 的修正只寫入 worktree 時為 `AI_FIX_UNCOMMITTED`，其他為 `HUMAN_REVIEW_REQUIRED`） | 檔案內容（`contentHash`），以及 AI 審查的依據：專案設定與 merge base 的 `codingstandards.md` 的 digest（報表的 `ai.standards.digest`） |

- AI 的輸出不是 deterministic 的，同一個問題在兩次審查中的標題可能不同，逐條確認會在每次重跑時失效；所以 AI 的項目**以檔案為單位**確認一次，確認的是整個檔案目前的內容，檔案一改就重新開啟。
- 只有兩種已知的組合可以不產生項目：機械審查略過（`AUTO_PASS` 且決策是 `NOT_SELECTED_FOR_HUMAN_REVIEW`），以及 AI 審查通過（`AI_TRACK`、決策是 `HUMAN_REVIEW_REQUIRED`、`needsHuman: false`、AI 結果是 `PASS`；路由只對這個決策產生 `AI_TRACK`，其他決策要升級，AI 不能放行）。AI 結果是 `FIXED`（`--ai-apply`）時不算：修正只寫入 worktree，報表的 head 是沒有修正的版本，要 commit 後在新的 head 重新審查。其他檔案（不認得的路由、欄位不一致或缺少、沒有執行 AI 審查）只要沒有單向門，就產生檔案層級的項目（fail-closed）。
- 有單向門的檔案：確認單向門只代表看過那個 method，不代表看過整個檔案。單向門以外的部分由 AI 審查；AI 的結果不是 `PASS` 時（沒有 `--ai`、AI 失敗、AI 判斷需要人工），或路由與決策不一致時（不是 `ESCALATED` 搭配 `HUMAN_REVIEW_REQUIRED`，例如不認得的決策：它被升級正是因為審查範圍不可信），另外產生一個檔案層級的項目。所以沒有 `--ai` 時，每個單向門檔案除了單向門之外還要確認整個檔案。
- 編號是 `F<n>-<id 前綴>`（例如 `F1-3fa2`）。`F<n>` 依路徑、種類（單向門在前）與行號配發、永不重用（修正後也不會給別的項目）；id 前綴讓狀態遺失後仍能找到正確的項目。前綴至少 4 碼，與其他已知項目重複時自動加長（例如 `F1-abcd1`）。
- finding id 不含行號、也不含 head 側的值（見 [PR Review CLI「Findings」](review-cli.md#findings)），所以在上方插入程式碼、或作者微調變更後的值時仍是同一項；被看過的程式碼是否又改了，由 `scopeHash` 判斷。

## 狀態

每次都從頭重算：**新狀態 = f(最新報表, 所有有效的確認)**。狀態留言只保存短編號、各 head 的 fingerprint 與已驗證的確認，所以 push 與確認留言的處理順序不影響結果。

| 狀態 | 條件 | Check |
|---|---|---|
| `OPEN`（🔴 待確認） | 目前的 head 有這一項，沒有確認過 | 失敗 |
| `ACKNOWLEDGED`（✅ 已確認） | 有一個確認的 scope 與 policy fingerprint 都等於目前的 | — |
| `REOPENED`（🟠 重新開啟） | 確認過，但之後所在的程式碼（`CODE_CHANGED`）或規則（`POLICY_CHANGED`）改了；或修正後再次出現（`REAPPEARED`：即使程式碼與之前確認的相同，修正前的確認也不再採用，要重新確認） | 失敗 |
| `FIXED`（🟢 已修正） | 之前出現過，目前的 head 已經沒有 | — |

Check 結論：有 `OPEN` 或 `REOPENED` 時為 `failure`，否則 `success`。Check 綁定報表的 head SHA。

## 確認指令

在 PR 留言（issue comment）：

```
/reviewer ack F1-3fa2@a1b2c3d 已確認改由呼叫端包 transaction
```

- `F1-3fa2`：儀表板上的編號；`@a1b2c3d`：看的時候儀表板顯示的 head（至少 7 碼）；之後是理由（必填）。儀表板每一項都附上可以複製的指令。
- 一則留言可以有多行指令（最多處理 20 個）。
- 每一行先做 NFKC 正規化：中文輸入法打出的全形 `＠`、全形空白、全形英數字視為半形。
- 引用（`>` 開頭，例如 GitHub 的 Quote reply）、程式碼區塊（` ``` ` / `~~~`）與縮排程式碼中的指令不算：引用別人的指令不等於自己確認。

確認依序檢查，第一個不符合的條件決定回覆：

| 條件 | 不符合時的回覆代碼 |
|---|---|
| 有 `created_at` 與 `updated_at`（缺少時無法偵測編輯） | `ACK_EDIT_UNKNOWN` |
| 留言沒有被編輯過（`updated_at` = `created_at`） | `ACK_EDITED` |
| 留言者不是 PR 作者 | `ACK_BY_AUTHOR` |
| 有留言者的權限資料 | `ACK_PERMISSION_UNKNOWN` |
| 權限至少是 `--ack-permission` | `ACK_PERMISSION_DENIED` |
| 有理由 | `ACK_REASON_MISSING` |
| id 前綴對應到已知的項目；對應到多個時以短編號縮小到唯一一個（重播時不縮小） | `ACK_ITEM_UNKNOWN` / `ACK_ID_AMBIGUOUS` |
| 編號與 id 前綴一致（狀態遺失後重播時不檢查） | `ACK_SHORT_ID_MISMATCH` |
| 目前的 head 有這一項 | `ACK_ITEM_FIXED` |
| `@head` 是 reviewer 分析過的 head（狀態中保存的最近 10 個，或 `--history` 的報表） | `ACK_SHA_AMBIGUOUS` / `ACK_SHA_UNKNOWN` |
| 這一項在 `@head` 時就存在 | `ACK_ITEM_NOT_AT_SHA` |
| `@head` 時的 scope fingerprint 等於目前的 | `ACK_CODE_CHANGED`：看完之後程式碼又改了，要求重看 |
| `@head` 時的 policy fingerprint 等於目前的 | `ACK_POLICY_CHANGED`：規則已更新，要求重看 |
| 重播時：`@head` 是目前的 head，或所有已知的 head 都有這一項 | `ACK_REPLAY_UNVERIFIABLE`：沒有狀態時無法判斷這一項是否修正後再次出現 |

通過時回覆 `ACK_ACCEPTED`（✅）。bot 的留言（`user.type` 為 `Bot` 或 login 以 `[bot]` 結尾）一律忽略；格式錯誤的 `/reviewer` 行回覆正確格式。每則留言只處理一次（狀態記錄 `lastProcessedCommentId`），回覆不會重複。

已接受的確認在之後的每次執行都會重新檢查：指令留言被刪除、被編輯過（或缺少時間而無法判斷）或作者不符，或確認者目前的權限低於現在的門檻（權限被移除、`--ack-permission` 提高）時，這個確認不再採用（項目回到待確認），儀表板說明有幾個確認因此失效。確認者要撤回確認，編輯或刪除指令留言即可。

`@head` 的檢查是為了「人看的是 A，推了 B 之後才送出確認，結果確認綁到 B」：確認綁定的是確認者看到的版本，不是送出確認時的最新版本。

## 狀態的保存

狀態以隱藏區塊放在儀表板留言的最後：

```html
<!-- reviewer:state v1 kid=<key id> sig=<HMAC-SHA256> -->
<!-- <base64(gzip(JSON))> -->
```

- 有 write 權限的人都能編輯 bot 的留言，所以狀態以 HMAC 簽章（涵蓋版本、key id 與內容）。簽章在解壓縮之前檢查；解壓縮後的上限是 1 MB。
- 簽章只保證狀態是 reviewer 產生的，不保證是最新的：有人可以把留言改回之前合法簽章的內容（例如項目修正前、已確認的狀態）。所以狀態只在儀表板留言由 bot 建立、而且最後一次編輯也是 bot 自己時採用：作者不是 bot 為 `STATE_NOT_FROM_BOT`，被其他人編輯過為 `STATE_EDITED_BY_OTHER`，沒有作者或 `editor` 資訊為 `STATE_EDITOR_UNKNOWN`，這些情況都丟棄狀態。REST 的 bot login 帶 `[bot]`、GraphQL 的不帶，比較時忽略這個後綴。這假設只有 workflow 能以 bot 的身分寫入留言、拿到 key。
- 區塊必須在留言的最後；說明文字中出現的類似字串不算。儀表板中來自程式碼與 AI 的文字一律跳脫 `<`、`>`、`&`、`|`、`` ` ``、`@`，不能插入 HTML、mention 別人或偽造區塊。
- 以下情況**丟棄狀態**，從頭重算（結果只會更嚴格）：上述的作者與編輯者不符、有儀表板但沒有區塊（`STATE_MISSING`，例如上次超過長度上限或區塊被刪掉）、沒有儀表板卻已經有確認指令（`DASHBOARD_MISSING`，例如儀表板留言被刪除）、沒有區塊但留言中有 `reviewer:state`（`STATE_MALFORMED`）、版本不認得、未簽章、key 不認得、簽章不符、解不開、形狀不對、屬於其他 PR（`STATE_PULL_REQUEST_MISMATCH`，防止複製別的 PR 的狀態）。
- 丟棄時，所有確認留言從頭重播：狀態中保存的 head 也一起丟了，所以只有能以 `--history` 的報表驗證 `@head` 的確認會保留，其他的回到待確認。重播時也不知道哪些項目曾經修正後再次出現，所以 `--history` 中有任何一個 head 沒有這一項時，只採用目前 head 的確認（與一般執行相同，只能偵測看過的 head 之間的變化；`--history` 應包含之前所有 head 的報表）。重播時不逐則回覆（避免洗版），改在儀表板說明重新驗證了幾個、幾個需要重新確認。
- 換 key：新的 key 放 `REVIEWER_STATE_KEY`，舊的放 `REVIEWER_STATE_PREVIOUS_KEYS`；舊狀態仍可驗證，下次寫出時改用新的 key。
- 保存的內容：短編號、各項目的狀態、最近 10 個 head 的 fingerprint（scope 與 policy 各取 sha256 前 32 碼，以短編號為 key）、已驗證的確認（理由保留前 200 字元）。
- 留言上限 65,536 字元。太長時依序省略檔案清單、減少保存的 head、移除已修正項目的確認；仍然太長時這次不保存狀態，在儀表板說明（下次從確認留言重算）。

## 輸出（`--out` / `--json`）

| 欄位 | 說明 |
|---|---|
| `pullRequest` / `headSha` | PR 編號與報表的 head |
| `previousState` | 上一版狀態的驗證結果：`{ status: "absent" \| "valid" \| "invalid", reason }` |
| `dashboard` | `{ body, stateSaved, signed }`：儀表板留言的完整內容（含隱藏狀態）。留言以第一行的 `<!-- reviewer:dashboard v1 -->` 找到同一則 |
| `check` | `{ headSha, conclusion: "success" \| "failure", title, pending }` |
| `replies` | 確認指令的回覆：`[{ commentId, body }]` |
| `threads` | 單向門的行內 thread 目標狀態：`[{ findingId, label, state: "open" \| "resolved", location, body }]`。`location` 為 `{ path, side: "LEFT" \| "RIGHT", startLine, line }`（已修正的項目為 `null`）；`body` 的最後一行是 `<!-- reviewer:finding <id> -->`，workflow 以它找到既有的 thread，沒有就建立（只建立 open 的），有就 resolve / unresolve。檔案層級的項目沒有 thread |
| `items` | 所有項目：`id`、`label`、`kind`、`state`、`blocker`、`path`、`location`、`reopenedBecause` |
| `notes` | 說明：`STATE_RESET`（狀態無法驗證，含 `reason`、`replayed`、`rejected`）、`ACKS_WITHDRAWN`（指令留言被刪除或編輯、或確認者權限不足而不再採用的確認數，含 `count`） |

## 與設計的差異

- **AI 的項目以檔案為單位確認**（設計是每個 finding 一項）：AI 的 finding id 在重跑時不穩定。
- **指令帶 id 前綴**（`F1-3fa2@…`，設計是 `F1@…`）：狀態遺失後短編號會重新配發，只靠 `F1` 可能綁到另一個項目。
- **規則只看產生該原因的 interpreter**（設計是整組 policy digest）：任何 interpreter 升級都讓所有確認失效太嚴，現在只有產生這個原因的規則改變才失效。
- **狀態不保存 thread id**：thread 內容帶 finding 標記，workflow 以標記找到 thread，不需要在建立 thread 後再寫一次狀態。
- **保存最近 10 個 head 的 fingerprint**，並可用 `--history` 提供之前的報表：設計中負責寫入的 workflow 不 checkout 程式碼，狀態遺失後無法自行算出舊 head 的 hash。
- 尚未實作：儀表板中「PR 自我宣告的風險與偵測結果不一致」一列、AI 產生的流程圖。

## 限制

- 不呼叫 GitHub API：取得 PR、留言、權限，以及寫回儀表板、回覆、thread、Check，都由之後的 workflow（7b）負責。
- 只讀 issue comments 中的指令，不讀 review comments（行內 thread 中的回覆）。
- 確認權限只有最低權限等級（預設 `write`），不支援「必須是 CODEOWNERS」。
- 確認只保證「所在的 method（或檔案）沒有再變過」。理由若依賴其他位置的程式碼（例如「已確認改由呼叫端包 transaction」），之後同一個 PR 又改了那個位置、且相對於 merge base 淨差異為零時，不會產生新的項目，這個確認仍然有效。
- 匿名 callback 中的單向門以外層具名 function（頂層程式碼為整個檔案）的 hash 綁定：這類檔案（Express 路由、Laravel `routes/*.php`）改任何一處，其中的確認都會重新開啟。
