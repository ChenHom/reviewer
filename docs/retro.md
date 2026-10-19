# Retro（`bin/retro.js`）

三層審查（機械 → AI → 人工）的閉環：定期彙整一段期間內的 review 報表，找出可以**強化**（讓機械審查自動抓到更多風險）與**精簡**（刪掉沒用的規範與規則）的地方。設計見 [三層審查架構設計](superpowers/specs/2026-10-18-three-tier-review-design.md) §7。

實作位置：

- `bin/retro.js`：參數解析與輸出。
- `src/retro/metrics.js`：讀取報表、留言與規範條目，計算 deterministic 指標。
- `src/retro/proposals.js`：AI 建議（`--ai`）、規則驗證與 mutation case 草案的驗證。
- `src/retro/format.js`：markdown 報告。
- 測試：`tests/retro/retro.test.js`。

## 用法

```bash
# 平常的 review 以 --out 留下 JSON 報表（CI 可以存成 artifact）
node bin/review.js --repo "$PROJECT_DIR" --base "$BASE_REF" --ai --out "reports/$HEAD_SHA.json"

# 定期執行 retro
node bin/retro.js --reports reports/ \
  --standards "$PROJECT_DIR/codingstandards.md" \
  --config "$PROJECT_DIR/.reviewer.json" \
  --comments human-comments.jsonl \
  --out-dir retro/
```

| 選項 | 說明 |
|---|---|
| `--reports <path>` | 必填，可重複。`bin/review.js --out` 的 JSON 報表，或放報表的目錄（目錄中所有 `.json`，不遞迴）。無法解析或不像 review 報表的檔案在 stderr 警告後略過；一份都沒有時以 `RETRO_NO_REPORTS` 結束 |
| `--comments <file>` | 人工 review 留言，JSON Lines，每行 `{"pr": …, "path": …, "body": "…", "author": …}`（`body` 必填）。無效的行在 stderr 警告後略過 |
| `--standards <file>` | `codingstandards.md`：統計 AI 的疑慮引用了哪些條目（以 `-`、`*`、`1.` 開頭的列表項目為條目） |
| `--config <file>` | `.reviewer.json`：專案的單向門也列入「沒有觸發」的統計；AI 建議的規則以它為基礎驗證。無效時以 `RETRO_CONFIG_INVALID` 結束 |
| `--out-dir <dir>` | 寫出 `retro.md`、`retro.json`；有 AI 建議時另外寫出 `reviewer.proposed.json`（加入有效規則後的設定）與 `mutation-drafts.json` |
| `--json` | stdout 輸出 `{ metrics, proposals }`（取代 markdown） |
| `--ai`、`--ai-model`、`--ai-effort` | 請 AI 提出建議（見下）。需要 `ANTHROPIC_API_KEY`，與 [PR Review CLI 的 AI 審查](review-cli.md#ai-審查第-2-層--ai) 使用相同的 client（預設 `claude-opus-5-5`、effort `high`、啟用 server-side fallback） |

exit code：0 完成；2 錯誤（stderr 印出 `error: <訊息>`）。retro 不會修改任何檔案，也不會開 PR。

## 指標（deterministic）

同一個 repository 與 head 的報表（例如重跑）只算一次。

| 段落 | 內容 | 用途 |
|---|---|---|
| 路由 | 檔案與 PR 的 `AUTO_PASS` / `AI_TRACK` / `ESCALATED` 比例；`TARGETED` / `FULL` 數量 | 審查負擔的趨勢 |
| 單向門 | 每個單向門的觸發次數；這段期間**沒有觸發**的單向門（與 review 相同的集合：預設清單、`.reviewer.json` 的 `oneWayDoors` 與 `protectedArguments` 自訂的 `blocker`） | 長期沒有觸發的專案規則可以考慮精簡 |
| FULL 的原因 | 機械審查無法解釋的原因（`COV-*`、`UNSUPPORTED_FILE_TYPE`、`ANALYZER_ERROR` 等）的次數 | 強化 analyzer 的優先順序 |
| FACT_UNHANDLED | 沒有任何 domain 規則的 fact 種類、次數與例子 | 新 interpreter、preset 或 `.reviewer.json` 規則的候選 |
| AI 審查 | 交給 AI 的檔案數、各狀態、失敗原因、`AI_TRACK` 中 AI 放行（含修正）的比例、由備援模型回答的數量、token 用量 | AI 層的效果與成本 |
| 人工 | 需要人工的檔案數、待確認項目（單向門 / AI） | 人工負擔 |
| codingstandards.md | 每個條目被 AI 疑慮引用的次數、**從未被引用**的條目、AI 引用但對不到條目的文字 | 規範檔精簡的候選（規範太肥會讓 AI 審查變差） |
| 人工留言 | 留言數、留言最多的檔案 | 需要 `--comments` |

豁免率、REOPENED 次數、PR 自我宣告與偵測不一致的次數需要 GitHub 狀態留言（設計的步驟 7），目前列為不可用。

## AI 建議（`--ai`）

AI 讀取指標、報表中 AI 的 high / medium 疑慮、人工留言、FACT_UNHANDLED 的例子、目前的 `codingstandards.md` 與 `.reviewer.json`，提出：

1. **`codingstandards.md` 新增**：人或 AI 重複提出的意見（必須附上依據；單一留言不足以成為規則）。
2. **`codingstandards.md` 刪除**：從未被引用、看起來過時或重複的條目。
3. **`.reviewer.json` 規則**：重複出現、結構明確、應該一律交給人工的風險。每條規則**逐條**加入目前的設定，以 `.reviewer.json` 的驗證器（`parseProjectConfig()`）檢查；無效的規則不採用並列出原因。設定只能新增攔截，AI 不會、也無法提出「忽略某個 fact」的規則。
4. **mutation case 草案**：每條規則（與其他重要缺口）附一個最小的 before / after。retro 以「加入有效規則後的設定」對草案執行同一套機械審查，確認預期的原因代碼真的出現（報告中標示「通過」或實際的路由與原因）。依設計，新規則必須有通過的 mutation case 才能合併；通過的草案可以搬進 `evaluation/mutations/cases.json` 與 `fixtures/`。

所有建議都是草案：請人工審核後以 PR 提出（設計的步驟 7 之後可由 workflow 自動開 PR）。人工留言與報表內容來自 PR，放在標籤中當成資料（與 AI 審查相同的 prompt injection 處理）；即使 AI 被誤導，建議也只是草案，規則與草案都要經過驗證與人工審核。

## 限制

- 只看報表中的內容：沒有 `--out` 留下的 review 不會被統計。
- 「從未被引用」只依 AI 疑慮的 `standard` 欄位比對，AI 沒有引用不代表規範沒有作用（例如 AI 因為規範而回答 PASS）。刪除前請人工判斷。
- 本 repo 的測試以假的 client 驗證 AI 建議的流程，沒有呼叫真實的 API。
