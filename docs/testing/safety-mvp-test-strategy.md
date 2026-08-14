# Safety MVP 測試策略

## 目的

這份文件是 Safety MVP 後續測試的強制規範。測試不只確認正常結果，還必須證明任何證據缺失、資料矛盾、結果過期或發布失敗，都不能產生 reduction success。

目前測試使用 Node.js native ESM、`node:test`、table-driven cases 與 deterministic exhaustive cases；不依賴 LLM、外部 Analyzer、網路或隨機資料。N-01 的 AdapterResult ingress 與 context binding contract tests 在範圍內，但可執行的外部 Adapter 不在範圍內。

## 測試分層

| 層級 | 目標 | 必須使用的入口 |
|---|---|---|
| Contract / Unit | 驗證單一模組的輸入、輸出與 reason code | 對應 production function |
| Property / Invariant | 驗證安全不變量不會被組合輸入破壞 | deterministic 生成或 exhaustive table |
| Vertical | 驗證一個完整業務分支 | `runSafetyMvp()` |
| End-to-end pipeline | 驗證 analysis、publication、Summary、status check 的跨模組綁定 | `runSafetyMvp()` + fixture |

測試命名必須說明「條件 → 預期安全結果」，使用正體中文；契約常數如 `PARTIAL_PARSE`、`FAILURE`、`STALE_ANALYSIS_IDENTITY` 保留原文。

## 每個案例的四面檢查

每個 production behavior 至少要有：

1. 正向案例：合法且完整的輸入能得到預期結果。
2. 反向案例：缺失、錯誤或矛盾輸入會 fail-closed。
3. 邊界案例：空值、最小值、最大值、零長度、邊界轉換與多筆組合。
4. 整合案例：結果經過下一個 authority boundary 後，安全語意仍然成立。

若一個案例同時測多個獨立錯誤，應拆成 table-driven cases；只有在需要驗證多錯誤聚合時，才保留多錯誤輸入。

## Safety invariants

所有後續測試都必須維護以下不變量：

- Required coverage 只要有一筆不是 `COMPLETE`，就不能產生 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- 空 coverage、空 changed region、缺 path/language/adapter/runtime 都不能被視為安全證據。
- `unknown` 或非法 runtime 必須保留 blocker。
- Normalized core input 的負值、零長度、逆序、重疊或未排序 byte range 必須 fail-closed；raw `AdapterResult` 可以未排序，但不可重疊，並由 N-02 normalization 排序後才進入 core。
- `ELIGIBLE` 不得含 blocker；`NOT_ELIGIBLE` 與 `ANALYSIS_FAILED` 必須有 blocker。
- 增加 blocker、移除 evidence 或降低 coverage，不得把 Human Review 變成 `NOT_SELECTED_FOR_HUMAN_REVIEW`。
- Candidate、Summary、Status Check 必須共用完整 `AnalysisIdentity`、相同 candidate digest，以及存在時的 `AnalysisContextBinding`。
- 舊 head、舊 policy、舊 runner 或晚完成舊 run 不得覆蓋 current authority。
- Analysis failure、Summary 缺失或 Summary 發布失敗不能回傳 status success。
- `PASS` 只代表 authoritative Summary 綁定正確，不代表不需要 Human Review；Review decision 必須另外檢查。

## 模組最低測試矩陣

### Contracts

- identity 六個欄位各自缺失與各自 mismatch。
- coverage 缺失、空 required set、缺 ID、重複 ID、未知 status。
- risk blockers、policy requirements、audit、analysis error 的型別錯誤。
- eligibility 狀態未知、blocker 缺失、`ELIGIBLE` 含 blocker。
- candidate status、coverage、eligibility、decision 的矛盾組合。

### Adapter Contract / Context Binding

- 合法的多 Adapter `AdapterSet`、capability allowlist，以及 adapter 順序的 canonical digest。
- 缺少、重複、錯誤型別或未知 capability；`diagnostics`、`evidenceReferences`、`complete` 與 `reasonCode` 的契約完整性。
- runtime namespace/id/source/version、未知 runtime blocker、language ownership，以及未宣告 adapter 的拒絕行為。
- range 邊界、raw 未排序但不重疊的接受行為，以及 raw 重疊的拒絕行為。
- `adapterSetDigest`、`executionContextDigest` 的 deterministic serialization、adapter/language 順序與 runtime tampering。
- authority context 缺漏、格式錯誤、legacy mismatch、binding mismatch、head transition 與失敗時不得改變 authoritative state。

### Normalization / Reference Adapter

- mixed-language regions 必須保留 path、byte range、language、adapter 與 runtime ownership，並按 path/range deterministic 排序。
- 同一 path 的零長度、逆序或重疊 region 必須拒絕；不同 path 的相同 byte range 不得互相誤判。
- `COMPLETE`、`PARTIAL_PARSE`、`UNSUPPORTED`、`TIMEOUT`、`TRUNCATED`、`FAILED` 的 mapping 必須可重現。
- reference adapter 只能 deep-clone fixture；aborted signal 必須回傳合法的 Adapter-declared `TIMEOUT` result。
- normalized runner 必須按 validation → normalization → `runSafetyMvp()` 順序執行，malformed result 必須進入 analysis failure。

### Coverage

- 合法單一與多筆 obligation。
- `PARTIAL_PARSE`、`UNSUPPORTED`、`TIMEOUT`、`TRUNCATED`、`FAILED`。
- 缺少 changed regions、空 changed regions、缺 path/language/adapter。
- 非法 runtime、`unknown` runtime。
- 負值、零長度、逆序、重疊、未排序與相鄰 byte ranges。
- 多個 required obligations 中任一筆失敗。

### Reducer

- `ELIGIBLE`、risk `NOT_ELIGIBLE`、coverage `NOT_ELIGIBLE`、`ANALYSIS_FAILED`。
- policy requirement 與 audit selection。
- blocker 去重、排序與完整保留。
- blocker 增加的 monotonic property test。
- eligibility 缺失與內部矛盾的 fail-closed 結果。

### Publication / Summary

- identity 六欄位逐一 mismatch。
- incomplete、invalid、矛盾 candidate 不得修改 authority。
- 新結果先發布後，舊結果晚完成不得覆蓋。
- Summary 缺失、發布失敗、identity 不同、digest 不同、內容竄改。
- Candidate 與 Summary 的 decision、coverage、eligibility 任一欄位變更都必須被偵測。
- Summary 與 Status Check 在 adapter ingress 存在時必須綁定同一 context binding；valid、malformed、缺一側、stale mismatch 與 head transition 都要覆蓋。

### Pipeline / Fixtures

- Human Review targeted。
- Human Review full。
- NOT_SELECTED。
- analysis failure。
- partial / unsupported / timeout / truncated coverage。
- stale head 與 stale Summary。
- `AdapterResult → AnalysisContextBinding → runner → authority → Summary/Status Check` 的 binding 必須一路保留且可驗證。

## Fixture 規範

每個 fixture 必須包含：

```json
{
  "identity": {},
  "adapterResult": {
    "adapterSet": [],
    "obligations": [],
    "diagnostics": [],
    "evidenceReferences": [],
    "complete": true
  },
  "coverage": { "obligations": [] },
  "riskBlockers": [],
  "policyRequirements": [],
  "expected": {
    "analysisStatus": "COMPLETE",
    "decisionStatus": "HUMAN_REVIEW_REQUIRED",
    "fallback": "TARGETED",
    "reasons": [],
    "headSha": "head-001",
    "checkState": "PASS",
    "checkReason": "CURRENT_AUTHORITATIVE_SUMMARY"
  }
}
```

N-01 fixture 必須提供 `AdapterResult`；stale-run fixture 也要把它放在被分析的 input context 內。測試會由該結果計算 binding，並將同一份 binding 傳給 runner 與 authority，驗證 context 被竄改或遺漏時 fail-closed。

Stale fixture 可以另外使用 `input` 與 `currentIdentity`，但必須明確寫出 publication reason 與 check reason。

## 測試品質門檻

每次修改 production code 或新增 fixture 後，必須執行：

```bash
npm run lint
npm run test:safety
npm run test:coverage
```

Pull request 與 pre-commit 不得只執行單一 test file。若新增 production branch，必須同一變更補上至少一個正向、反向、邊界或整合案例，並在本文件矩陣中留下對應項目。

## 不在本策略內的項目

以下需要獨立的 integration test suite，不由 deterministic Safety MVP tests 假裝涵蓋：

- 真實 parser、可執行的外部 Language Adapter、Framework Adapter（N-01/N-02 contract、normalization 與 reference adapter tests 在範圍內）。
- 真實 GitHub API、database transaction、CAS 或跨 process locking。
- 外部 analyzer process 的 OS timeout 與網路失敗。
- 大型 repository 的效能、資源限制與負載測試。
