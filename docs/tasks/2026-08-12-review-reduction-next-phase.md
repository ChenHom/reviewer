# Review Reduction Next Phase Tasks

Status: `IN_PROGRESS`

Design spec: [Review Reduction Next Phase Design](../superpowers/specs/2026-08-12-review-reduction-next-phase-design.md)

Implementation plan: [Review Reduction Next Phase Implementation Plan](../superpowers/plans/2026-08-12-review-reduction-next-phase.md)

Predecessor: [Safety MVP Tasks](./2026-08-12-safety-mvp.md)

## Goal

先完成 Adapter ingress 的安全邊界，再以 gated follow-up 逐步接入 evidence/impact/invariant facts、持久化 authority 與 GitHub publication sink。第一批只執行 N-01～N-03，不把所有後續 subsystem 視為同一次 release。

## Non-negotiable safety rules

- Adapter 不得直接產生 reduction decision。
- Adapter output 必須先 validation、再 normalization，最後才能進入 `runSafetyMvp()`。
- 缺 path、language、adapter、runtime、execution context、evidence 或 identity 時必須 fail-closed。
- Adapter 宣告 obligation `TIMEOUT` 必須是 `INCOMPLETE` + Human Review；runner execution deadline timeout 必須是 `ANALYSIS_FAILED` + Full Review + check `FAILURE`。
- `PARTIAL_PARSE`、`UNSUPPORTED`、`TRUNCATED`、`FAILED` 不得成為 reduction success evidence；adapter 宣告的 `TIMEOUT` 也不得成為 reduction success evidence。
- `unknown` runtime 只能產生 diagnostic/blocker，不能讓 eligibility 變成 `ELIGIBLE`。
- Impact、invariant 與 evidence layer 只能增加 blocker，不能移除既有 blocker。
- Authority publication 必須使用 CAS 或等價 transaction；stale run 必須 no-op。
- GitHub sink 只能發布 authoritative Summary/check，不得反向改寫 decision。
- 每個新 behavior 必須有正向、反向、邊界與整合測試，並遵守 [Safety MVP 測試策略](../testing/safety-mvp-test-strategy.md)。

共用 failure codes：`ADAPTER_EXECUTION_TIMEOUT`、`ADAPTER_EXCEPTION`、`ADAPTER_RESULT_INVALID`、`ADAPTER_ABORTED`、`AUTHORITY_CAS_STALE`、`AUTHORITY_CAS_CONFLICT`、`GITHUB_PUBLICATION_FAILED`。

## Execution order

### N-01 — Adapter / Runtime Context / Identity Contract

Status: `IMPLEMENTED`

- [x] 建立 AdapterSet、AdapterResult、region-level runtime context 與 execution context contract。
- [x] 以 `adapterSetDigest` 與 `executionContextDigest` 建立 AnalysisContextBinding；不把單一 adapter 塞進既有六欄 AnalysisIdentity。
- [x] 補齊合法 context、缺欄位、未知 runtime、錯型別與 identity mismatch tests。
- [x] 更新既有 fixtures，保持 candidate、Summary、status check 使用相同 AnalysisIdentity 與 AnalysisContextBinding。

Exit criteria: AdapterSet 與 region runtime contract 可驗證；任何 context binding mismatch 都回傳明確 contract failure，任何 repository/policy/runner 或 context identity mismatch 都回傳 `STALE_ANALYSIS_IDENTITY`。

### N-02 — Mixed-language Normalization / Reference Adapter

Status: `PLANNED`

- [ ] 建立不重疊、已排序、保留 language ownership 的 changed-region normalization。
- [ ] 建立 PHP/HTML/JavaScript mixed-language reference fixture。
- [ ] 將 `PARTIAL_PARSE` 等 adapter terminal status 映射到既有 coverage contract。
- [ ] 保留 `runSafetyMvp()` direct normalized input 相容性。
- [ ] 將 `test:safety` 改為遞迴 `node --test tests`，在加入 `tests/adapters/` nested suites 前完成。

Exit criteria: mixed-language COMPLETE 可進入 core；任一 partial region 都保留 Human Review。

### N-03 — Adapter Execution Boundary

Status: `PLANNED`

- [ ] 實作 adapter-declared terminal timeout、execution deadline timeout、AbortSignal、exception、malformed output 與 late-result protection。
- [ ] 建立 injected fake adapter tests。
- [ ] 將 execution deadline、exception、malformed output 接到 `ANALYSIS_FAILED` / FULL / check `FAILURE`；adapter 宣告的 obligation timeout 維持 `INCOMPLETE` / Human Review。

Exit criteria: adapter-declared timeout 只能產生不完整 coverage；execution deadline、throw、malformed、late completion 都不能修改 authority 或產生 reduction success。

### N-04 — Evidence / Impact / Invariant Facts

Status: `PLANNED`

- [ ] 建立 evidence item 與 provenance contract。
- [ ] 建立 impact unresolved edge 與 required subject checks。
- [ ] 建立 invariant mapping missing/provenance mismatch checks。
- [ ] 將所有 unresolved facts 聚合為 reducer blockers。

Exit criteria: unresolved evidence/impact/invariant 只能增加 Human Review blocker，不能導向 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

### N-05 — Persistent Authority / CAS Publication

Status: `PLANNED`

- [ ] 定義 storage port 與 memory implementation。
- [ ] 使用 Node.js 24 `node:sqlite` 建立 authority schema 與 transaction。
- [ ] 以 `advanceCurrentHead({ expectedHead, nextHead })` 在同一 transaction 更新 head 並清除舊 candidate。
- [ ] 實作 expected identity CAS、same-digest idempotency 與 same-head conflict rejection。
- [ ] 補齊 restart、new head、late old run 與 no-mutation tests。

Exit criteria: process restart 後仍能辨識 current authority；stale/conflict candidate 不會覆蓋 authoritative result。

### N-06 — GitHub Summary / Status Check Sink

Status: `PLANNED`

- [ ] 先定義 provider-neutral `upsertSummary` / `upsertCheck` port，再定義 GitHub adapter transport contract。
- [ ] 驗證 Summary、candidate digest、head SHA 與 check state 綁定。
- [ ] 使用 head SHA、candidate digest 與固定 marker 實作 retry-safe upsert；不假設 GitHub 原生支援任意 idempotency key。
- [ ] 將 transport failure 保持為 delivery failure，不改寫 authority。

Exit criteria: fake transport 的 success、非 2xx、timeout、malformed response、retry 與 conflict 都有 deterministic tests。

### N-07 — Full E2E / CI / Operations

Status: `PLANNED`

- [ ] 建立 adapter → normalization → core → CAS → GitHub sink 的 E2E fixtures。
- [ ] 覆蓋 mixed-language、partial parse、unknown runtime、timeout、restart stale、GitHub failure。
- [ ] 確認 `test:safety` 已由 N-02 固定為遞迴 `node --test tests`，並建立 `test:e2e` 與 `test:all` release gate；禁止只用 `tests/*.test.js`。
- [ ] 更新 architecture、operations 與 failure/retry 文件。

Exit criteria: lint、unit、coverage、adapter、storage、sink、E2E 全部通過，且無網路、LLM 或真實 token 依賴；head transition、CAS、Summary 與 sink retry 的 race cases 都有測試。

## Verification commands

每個 N-task 完成前：

```bash
npm run lint
npm run test:safety
npm run test:coverage
git diff --check
```

N-07 完成時再執行：

```bash
npm run test:all
```

## Explicitly deferred

- 完整 PHP/Laravel、Blade/Vue/JSX parser。
- LLM hypothesis generation。
- Cross-repository assurance、merge queue 與 distributed lock service。
- 高負載效能與大型 repository benchmark。
- 真實 GitHub token、live API 與 production credential setup。

## Phase gate

N-01～N-03 完成前，不得開始 N-04～N-07。第一批的 release gate 是：

```bash
npm run lint
npm run test:safety
npm run test:coverage
git diff --check
```

其中 `npm run test:safety` 在 N-02 完成後就必須遞迴執行所有已存在測試；N-07 只新增 `test:e2e` 與 `test:all`，不得把 nested test discovery 延後到最後階段。
