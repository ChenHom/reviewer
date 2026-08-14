# Safety MVP Next Phase 操作與失敗處理

## 生產責任邊界

完整流程固定為：

```text
Adapter execution
  -> AdapterResult validation
  -> normalization / context binding
  -> deterministic core
  -> authority CAS store
  -> authoritative Summary + status check
  -> optional GitHub sink
```

Adapter、evidence、impact、invariant 與 GitHub sink 都不能直接改寫 reduction decision。只有 CAS 成功的 candidate 才能成為 authoritative candidate；sink 是 delivery-only，不會回頭改寫 authority 或 check。

## Release gate

本地與 CI 使用同一組命令：

```bash
npm ci
npm run test:all
```

`test:safety` 使用遞迴 `node --test`，`test:e2e` 明確執行 `tests/e2e/*.test.js`（Node.js 24.3 不接受目錄作為 test input），`test:coverage` 的最低門檻為 lines/functions/statements 90%、branches 85%。測試不依賴網路、LLM、真實 GitHub token 或 production credential。

## Authority 與 CAS

- `MemoryAuthorityStore` 只用於 deterministic unit/integration tests。
- `SqliteAuthorityStore` 以唯一 repository row 保存 current head、context binding、candidate digest 與 candidate JSON。
- `advanceCurrentHead()` 在同一 transaction 驗證 expected head、切換新 head 並清除舊 candidate。
- `compareAndSwapCurrent()` 只在 persisted head 與 context binding 都相符時寫入。
- stale candidate 回傳 `AUTHORITY_CAS_STALE`；同一 head 不同 digest 回傳 `AUTHORITY_CAS_CONFLICT`；兩者都不得修改 authority。
- 同一 head/digest 重試回傳 idempotent success，並重用同一 authoritative candidate。

SQLite database 重啟後必須先讀回 current head，再處理新的 run。正式環境應由外部備份策略保護 database 檔案；測試使用 temporary database，測試結束即清理，不得把測試檔案當成 production backup。

## Summary、status check 與 sink

`PASS` 只代表 candidate、Summary、Status Check 與 current authority 的 identity、context binding、digest 綁定正確，不代表 decision 是 `NOT_SELECTED_FOR_HUMAN_REVIEW`。`ANALYSIS_FAILED`、stale、Summary 發布失敗都必須維持 failure 語意。

GitHub publisher 使用 provider-neutral `upsertSummary` / `upsertCheck` port，request 固定帶有：

- marker：`REVIEW_REDUCTION_SAFETY`
- repository
- head SHA
- candidate digest
- authoritative Summary
- status check

transport 的非 2xx、timeout、exception、malformed response 或 conflict 都只回傳 `GITHUB_PUBLICATION_FAILED`。retry 是否去重由 marker + head SHA + candidate digest 交給 transport 實作；publisher 不假設 GitHub 原生提供任意 idempotency key。

## Incident handling

| Reason | 意義 | 安全行為 |
|---|---|---|
| `ANALYSIS_FAILED` | 分析輸入或 execution 不可信 | Full Review、check FAILURE |
| `AUTHORITY_CAS_STALE` | run 不是 current head | no-op，不建立 Summary/sink delivery |
| `AUTHORITY_CAS_CONFLICT` | 同 head 已有不同 candidate digest | 保留既有 authority，人工處理衝突 |
| `GITHUB_PUBLICATION_FAILED` | 外部 delivery 未確認成功 | authority 不變，可用相同 head/digest retry |

不應以重跑或手動重送來掩蓋 stale/conflict；先確認 persisted current head 與 candidate digest，再決定是否建立新 run。
