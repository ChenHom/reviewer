# Safety MVP Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 補齊 Safety MVP 的正向、反向、邊界、property 與 pipeline regression tests，並建立後續測試必須遵守的測試策略。

**Architecture:** 保持既有 production module boundary，不以測試重複實作 production decision。Unit tests 驗證局部 contract，deterministic property tests 驗證安全不變量，vertical/E2E tests 一律透過 `runSafetyMvp()` 驗證跨模組綁定。只有新測試揭露實際 fail-open behavior 時才修改 production code。

**Tech Stack:** Node.js native ESM, `node:test`, ESLint/JSDoc, `c8`, JSON fixtures；不使用 LLM、外部網路或隨機測試資料。

---

### Task 1: 建立測試規範與 coverage gate

**Files:**
- Create: `docs/testing/safety-mvp-test-strategy.md`
- Create: `docs/superpowers/plans/2026-08-12-safety-mvp-test-hardening.md`
- Modify: `package.json`, `package-lock.json`, `.github/workflows/review-reduction-safety.yml`

- [x] 定義測試分層、四面檢查、安全不變量、fixture schema 與模組測試矩陣。
- [x] 使用 `c8` 新增 `npm run test:coverage`，並在 CI 執行 lint、safety tests、coverage gate。

### Task 2: 補齊 Contracts 與 Coverage 邊界

**Files:**
- Modify: `tests/contracts.test.js`, `tests/coverage.test.js`

- [x] 以 table-driven cases 覆蓋 identity 六欄位、缺失/重複 obligation ID、未知 status、型別錯誤。
- [x] 覆蓋 changed regions 缺失、adapter/runtime 缺失、非法 runtime、byte range 零長度/逆序/負值/重疊/未排序。
- [x] 覆蓋多筆 required obligations 任一筆不完整時的 fail-closed 結果。
- [x] 先執行 targeted tests 確認新增案例在缺少 behavior 時能正確失敗，再保留最小 implementation 修正。

### Task 3: 補齊 Reducer、Publication 與 Summary 矩陣

**Files:**
- Modify: `tests/reducer.test.js`, `tests/publication.test.js`, `tests/summary.test.js`

- [x] 覆蓋 policy requirement、audit selection、analysis error 與 blocker 排序/去重。
- [x] 以 identity field table 驗證任何 identity 變更都拒絕 publication。
- [x] 覆蓋 candidate 內部 status、coverage、eligibility、decision 的矛盾組合。
- [x] 覆蓋 Summary invalid payload、每個內容欄位變更、digest mismatch 與 stale Summary。

### Task 4: 補齊 Pipeline fixtures 與 E2E

**Files:**
- Create: `fixtures/safety-mvp/coverage-timeout.json`
- Create: `fixtures/safety-mvp/coverage-unsupported.json`
- Create: `fixtures/safety-mvp/coverage-truncated.json`
- Modify: `tests/pipeline.test.js`, `tests/vertical.test.js`

- [x] 所有 fixture branch 透過 `runSafetyMvp()`。
- [x] 驗證 partial/unsupported/timeout/truncated 都不能變成 NOT_SELECTED。
- [x] 驗證 analysis failure、stale head、stale Summary、late old run 的完整 check 結果。
- [x] 驗證 Human Review 的 `PASS` 只表示 authoritative Summary 正確，不表示不需人工審查。

### Task 5: Verification and documentation handoff

**Files:**
- Modify: `docs/tasks/2026-08-12-safety-mvp.md`

- [x] 更新 task 文件連結至測試策略與 coverage command。
- [x] 執行 `npm run lint`、`npm run test:safety`、`npm run test:coverage`。
- [x] 執行 `git diff --check` 並檢查 working tree。
- [x] 新增 production behavior 時同步更新本測試策略矩陣。
