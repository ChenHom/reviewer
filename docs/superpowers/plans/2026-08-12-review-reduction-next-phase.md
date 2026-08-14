# Review Reduction Next Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Safety MVP 的 Adapter ingress、evidence/impact/invariant facts、持久化 authority、GitHub sink 與 full E2E release gate。

**Architecture:** `src/runner.js` 與既有 deterministic core 仍是唯一 decision authority；Adapter facts、evidence/impact/invariant facts、storage 與 external publication 都透過明確 port/adapter 邊界接入，不能直接產生或改寫 reduction decision。

**Tech Stack:** Node.js 24 native ESM、`node:test`、`node:sqlite`、JSON fixtures、注入式 fake transport、ESLint/JSDoc、c8；核心測試不使用網路、LLM 或真正外部 parser。

**Design spec:** `docs/superpowers/specs/2026-08-12-review-reduction-next-phase-design.md`

**Scope gate:** N-04 依賴 N-01～N-03；N-05 依賴 N-01、N-03；N-06 依賴 N-05；N-07 依賴 N-03、N-05、N-06。每個 task 都必須先通過 targeted tests，再通過完整 release gate。

---

## Task N-01: Adapter、Runtime Context 與 Identity Contract

**Files:**
- Create: `src/adapters/contracts.js`
- Create: `tests/adapters-contracts.test.js`, `tests/context-binding.test.js`
- Modify: `src/contracts.js`, `src/summary.js`, `src/publication.js`, `src/runner.js`
- Modify: `tests/contracts.test.js`, `tests/summary.test.js`, `tests/publication.test.js`, `tests/pipeline.test.js`, `tests/vertical.test.js`
- Modify: `fixtures/safety-mvp/*.json`

- [x] **Step 1: Write failing contract tests**

在 `tests/contracts.test.js` 加入 table-driven cases，使用 AdapterSet、region-level runtime context、obligation、changed region 與 diagnostics。拒絕缺 adapter id/version、空 language list、缺 runtime context、空 runtime id、非法 namespace、缺 changed-region language/adapter、未知 obligation status；合法 `server`、`client`、`edge`、`worker`、`external` context 必須通過。測試也要確認同一 analysis 可包含多個 adapter。

使用以下最小合法 context：

```js
{
  namespace: 'server',
  id: 'server:api',
  version: 'node-24',
  source: 'adapter'
}
```

- [x] **Step 2: Run tests to confirm the contract is missing**

Run: `node --test tests/contracts.test.js`

Expected: 新增 Adapter contract cases FAIL，因為 `src/adapters/contracts.js` 與 runtime context validation 尚未存在。

- [x] **Step 3: Implement the contract boundary**

在 `src/adapters/contracts.js` export：

```js
export const ADAPTER_STATUSES = Object.freeze([
  'COMPLETE', 'PARTIAL_PARSE', 'UNSUPPORTED', 'TIMEOUT', 'TRUNCATED', 'FAILED',
]);

export function canonicalRuntimeContext(context) {
  const allowed = ['server', 'client', 'edge', 'worker', 'external', 'unknown'];
  if (
    !context
    || !allowed.includes(context.namespace)
    || typeof context.id !== 'string'
    || context.id.trim() === ''
    || typeof context.source !== 'string'
    || context.source.trim() === ''
  ) return null;

  return {
    id: context.id,
    namespace: context.namespace,
    source: context.source,
    version: context.version ?? null,
  };
}

export function validateAdapterResult(result) {
  const errors = [
    ...validateAdapterSet(result?.adapterSet),
    ...validateRegions(result?.obligations),
    ...validateTerminalStatuses(result?.obligations),
  ];
  return { valid: errors.length === 0, errors: stableStrings(errors) };
}
```

`validateAdapterSet()`、`validateRegions()` 與 `validateTerminalStatuses()` 必須對缺欄位、錯型別、重複 id、region range、runtime context、未知 status 產生 stable reason code；預期 invalid input 不得 throw。Adapter terminal status 在 N-02 才映射成既有 `COVERAGE` status。Adapter 宣告的 `TIMEOUT` 與 execution deadline timeout 不得在 contract 中混為一談。

AdapterResult 也必須驗證 `capabilities`、`diagnostics`、`evidenceReferences`、`complete` 與 `reasonCode`。第一版 capability allowlist 固定為 `changed-regions`、`runtime-context`、`coverage-obligations`、`evidence-references`；evidence references 在 N-01 僅驗證為不重複的 stable string ids。`complete: false` 必須帶 reason code；`complete: true` 時所有 required obligation 都必須 `COMPLETE`，且 required COMPLETE obligation 不得沒有 changed region。

- [x] **Step 4: Bind context identity without changing the six-field AnalysisIdentity**

保留既有六欄 `AnalysisIdentity`，另在 candidate/summary binding 增加 canonical `adapterSet`、canonical `regions`、`adapterSetDigest` 與 `executionContextDigest`，以便每個 publication boundary 重算。`adapterSetDigest` 包含所有 adapter id/version；`executionContextDigest` 包含所有 region path、byte range、language、adapter id 與 runtime context。兩個 digest 都由 canonical data 計算，不接受 adapter 自行宣稱。更新 candidate digest、Summary 與 publication 的 binding 比較。legacy candidate 與 legacy authority 只有在雙方都沒有 binding 時才相容；任一側有 binding 時，另一側也必須存在、有效且 digest 完全相同。

- [x] **Step 5: Update fixtures and identity matrix**

所有 `fixtures/safety-mvp/*.json` 補上 AdapterSet 與固定 region runtime context。identity mismatch table 保持六欄；另增加 context binding mismatch cases，context binding 不同時必須拒絕 publication，不可誤當成相同 run。

- [x] **Step 6: Verify**

Run:

```bash
npm run lint
npm run test:safety
npm run test:coverage
```

Expected: 既有安全測試與 Adapter contract 測試通過，coverage gate 不低於既有門檻。

---

## Task N-02: Mixed-language Normalization 與 Reference Adapter

**Files:**
- Create: `src/adapters/normalize.js`
- Create: `src/adapters/reference-adapter.js`
- Create: `fixtures/adapters/mixed-language-blade.json`
- Create: `fixtures/adapters/mixed-language-partial.json`
- Create: `tests/adapters/normalize.test.js`, `tests/adapters/reference-adapter.test.js`
- Modify: `src/runner.js`, `src/coverage.js`, `tests/coverage.test.js`, `tests/vertical.test.js`, `package.json`

- [x] **Step 1: Write failing normalization tests**

對同一 `page.blade.php` 的 PHP、HTML、JavaScript 三段 changed regions 驗證：每段保留 language ownership、adapter id、runtime context；regions 必須已排序且不重疊。另測試零長度、重疊、不同 path、缺 language、`PARTIAL_PARSE` 與非必要 unsupported。

- [x] **Step 2: Run targeted tests**

Run: `node --test tests/adapters/normalize.test.js tests/adapters/reference-adapter.test.js`

Expected: FAIL，因為 adapter modules 與 fixtures 尚未建立。

- [x] **Step 3: Implement normalizeAdapterResult**

只做 schema normalization，不做 risk 推論，輸出既有 core 可接受的：

```js
{
  identity,
  contextBinding,
  coverage: { obligations: [] },
  riskBlockers: [],
  policyRequirements: [],
  audit: false,
  diagnostics: []
}
```

固定映射：`COMPLETE → COMPLETE`；`PARTIAL_PARSE`、`UNSUPPORTED`、`TIMEOUT`、`TRUNCATED → INCOMPLETE + reasonCode`；`FAILED → FAILED + reasonCode`。這裡的 `TIMEOUT` 僅指 Adapter 已交付的 obligation terminal status。Normalize failure 回傳 analysis failure input，不得製造空 coverage 或 `ELIGIBLE`。

- [x] **Step 4: Implement the deterministic reference adapter**

`createReferenceAdapter(fixture)` 只讀 fixture，回傳 descriptor 與 `analyze(request, { signal })`。signal 已 aborted 時回傳 `TIMEOUT` diagnostic；正常時 deep-clone fixture result。它只用於 deterministic tests，不實作 parser。

- [x] **Step 5: Connect normalized adapter results to the runner**

新增 `runNormalizedAdapterResult(result, authorityState, options)`，順序固定為 validate → normalize → `runSafetyMvp()`。保留既有 `runSafetyMvp()` signature。

- [x] **Step 6: Make test discovery recursive before adding nested suites**

將 `package.json` 的 `test:safety` 固定為 Node.js test runner 的遞迴 discovery：

```json
"test:safety": "node --test"
```

Node.js 24.3.0 不接受 `tests` 目錄作為 `--test` 的輸入；不帶路徑時會遞迴發現 root 與 nested test files。這一步必須在 `tests/adapters/` 測試加入前完成，避免 nested tests 未被 CI 或 local gate 執行。

- [x] **Step 7: Verify**

Run:

```bash
npm run lint
node --test tests/adapters/*.test.js tests/vertical.test.js
npm run test:coverage
```

Expected: mixed-language COMPLETE 可進入 core；任一 partial region 都保留 Human Review，不能變成 `NOT_SELECTED_FOR_HUMAN_REVIEW`；nested adapter tests 會被 `npm run test:safety` 發現。

---

## Task N-03: Adapter Execution Timeout、Exception 與 Abort Boundary

**Files:**
- Create: `src/adapters/runner.js`, `src/adapters/errors.js`
- Create: `tests/adapters/runner.test.js`
- Modify: `src/runner.js`, `tests/pipeline.test.js`

- [x] **Step 1: Write failing execution tests**

用 injected fake adapter 覆蓋 resolve valid、adapter-declared obligation timeout、execution deadline timeout、throw、malformed result、late resolution、pre-aborted signal。每個案例驗證 authority 沒有被未驗證結果修改，並驗證兩種 timeout 的 output 不同。

- [x] **Step 2: Run the targeted test**

Run: `node --test tests/adapters/runner.test.js`

Expected: FAIL，因為 `runAdapter()` 尚未存在。

- [x] **Step 3: Implement runAdapter**

`runAdapter(adapter, request, { timeoutMs })` 必須建立 AbortController；execution deadline 超過時回傳 `ADAPTER_EXECUTION_TIMEOUT` / `ANALYSIS_FAILED` input，catch exception 回傳 `ADAPTER_EXCEPTION`，malformed output 回傳 `ADAPTER_RESULT_INVALID`，pre-aborted 回傳 `ADAPTER_ABORTED`；late resolution 不得觸發 publication。stack trace 不得進入 candidate digest。Adapter 自己回傳 obligation `TIMEOUT` 時，交給 N-02 normalization 成 `INCOMPLETE`，不是 execution failure。

- [x] **Step 4: Connect the adapter pipeline**

`runAdapterPipeline()` 先完成 adapter execution、validation、normalization，再呼叫 `runSafetyMvp()`。execution deadline、exception、malformed output 固定走 `ANALYSIS_FAILED` / FULL / check `FAILURE`；adapter-declared obligation timeout 維持 `INCOMPLETE` / Human Review。

- [x] **Step 5: Verify**

Run:

```bash
npm run lint
npm run test:safety
npm run test:coverage
git diff --check
```

Expected: timeout、throw、malformed 與 late completion 都 fail-closed。

---

## Task N-04: Evidence、Impact 與 Invariant Blocker Pipeline

**Files:**
- Create: `src/evidence.js`, `src/impact.js`, `src/invariants.js`
- Create: `tests/evidence.test.js`, `tests/impact.test.js`, `tests/invariants.test.js`
- Create: `fixtures/safety-mvp/unresolved-evidence.json`
- Modify: `src/runner.js`, `src/reducer.js`, `tests/reducer.test.js`, `tests/vertical.test.js`

- [x] **Step 1: Write evidence contract tests**

每個 evidence item 必須有 stable id、source、subject、kind、completeness 與 provenance。固定 schema 為 `{ id, source, subject, kind, complete, provenance: { path, startByte, endByte } }`。`requiredSubjects` 與 `requiredInvariants` 必須由 `policyId + policyVersion` 決定，不由 Adapter 自行擴張。缺 id/source/subject、`complete: false`、重複 id、非法 provenance 都要產生 blocker；confidence 不能取代 completeness。

- [x] **Step 2: Implement evidence validation**

`validateEvidence()` 回傳 `{ valid, blockers, items }`，使用 `stableStrings()` 去重排序後交給 eligibility reducer。

- [x] **Step 3: Write impact boundary tests**

`evaluateImpact({ nodes, edges, requiredSubjects })` 必須保留 provenance；找不到 node 回傳 `IMPACT_EDGE_UNRESOLVED`；required subject 無可驗證 edge 回傳 `IMPACT_SUBJECT_UNRESOLVED`；重複 edge 去重，且不刪除既有 risk blocker。

- [x] **Step 4: Write invariant mapper tests**

`mapInvariants({ changedSubjects, mappings, requiredInvariants })` 對缺 mapping、空 required set、provenance mismatch 回傳 `INVARIANT_MAPPING_MISSING`、`INVARIANT_REQUIRED_SET_MISSING`、`INVARIANT_PROVENANCE_MISMATCH`。成功 mapping 只提供 evidence，不直接產生 `NOT_SELECTED`。

- [x] **Step 5: Connect facts to reducer**

Runner 將 evidence、impact、invariant blockers 合併進 `riskBlockers`；reducer 不增加第二套 decision table。增加 deterministic property test：增加任何 unresolved fact 都不能把 Human Review 改成 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

- [x] **Step 6: Verify the unresolved-evidence fixture**

透過 `runSafetyMvp()` 驗證 Human Review、reason 保留、Summary digest 一致，以及 authoritative Summary 正確時 status check 才能 PASS。

---

## Task N-05: SQLite Authority Store 與 Compare-and-Swap Publication

**Files:**
- Create: `src/storage/authority-store.js`, `src/storage/memory-authority-store.js`
- Create: `src/storage/sqlite-authority-store.js`, `src/storage/schema.sql`
- Create: `tests/storage.test.js`
- Modify: `src/publication.js`, `src/runner.js`, `tests/publication.test.js`, `tests/pipeline.test.js`
- Modify: `package.json`, `.github/workflows/review-reduction-safety.yml`

- [x] **Step 1: Write memory-store behavior tests**

驗證 initialize head、CAS expected head、stale CAS no mutation、atomic head transition、新 head invalidation、same digest retry idempotency、same head different digest conflict。

- [x] **Step 2: Define the storage port**

`src/storage/authority-store.js` export `readCurrentHead()`、`readCurrent()`、`advanceCurrentHead()`、`compareAndSwapCurrent()` 與：

```js
export const STORAGE_REASONS = Object.freeze({
  STALE: 'AUTHORITY_CAS_STALE',
  CONFLICT: 'AUTHORITY_CAS_CONFLICT',
});
```

Port 不依賴 SQLite API，publication tests 使用 memory implementation。

- [x] **Step 3: Implement SQLite transaction**

`schema.sql` 建立唯一 repository row，保存 identity JSON、head SHA、candidate digest、candidate JSON、updated timestamp。`advanceCurrentHead()` transaction 以 repository + expected head 條件更新 head 並清除 candidate；CAS transaction 以 repository + persisted current head 條件更新 candidate；affected rows 為 0 時回傳 stale/conflict，不寫入。

- [x] **Step 4: Make publication storage-backed**

保留 `validateCandidate()` 與 `sameIdentity()` 作為 publication 前置檢查；只有 CAS 成功才回傳 authoritative candidate，Summary 只能從 CAS 成功結果建立。

- [x] **Step 5: Write restart and late-run tests**

Temporary SQLite database 寫入 candidate、close、reopen、讀回；新 head 後送舊 candidate 為 no-op；同 head 不同 digest 回傳 conflict。

- [x] **Step 6: Verify**

Run:

```bash
npm run lint
node --test tests/storage.test.js tests/publication.test.js tests/pipeline.test.js
npm run test:coverage
```

Expected: restart、stale run、same-head conflict 都不能產生第二個 authoritative result。

---

## Task N-06: GitHub Summary 與 Status-check Publisher Boundary

**Files:**
- Create: `src/integrations/github/contracts.js`, `src/integrations/github/publisher.js`
- Create: `tests/integrations/github-publisher.test.js`
- Modify: `src/runner.js`, `tests/pipeline.test.js`, `docs/safety-mvp-architecture.md`

- [x] **Step 1: Write provider-neutral publication port tests**

先定義 provider-neutral `upsertSummary` / `upsertCheck` port。Fake transport 覆蓋 success、non-2xx、timeout、malformed response、相同 head/digest retry、相同 head 不同 digest。

- [x] **Step 2: Implement payload validation**

驗證 repository、head SHA、candidate digest、decision、coverage、eligibility 與 check state 完整綁定。`PASS` 搭配 analysis failure 或 digest mismatch 必須拒絕送出。

- [x] **Step 3: Implement provider-safe publication**

`publishGithubResult(transport, payload)` 先 validate，再使用 head SHA、candidate digest 與固定 marker 進行 provider-safe upsert；不假設 GitHub 原生支援任意 idempotency key。成功回傳 receipt，失敗回傳 `GITHUB_PUBLICATION_FAILED`。Publisher 不得修改 authority 或 candidate。

- [x] **Step 4: Connect as a sink only**

Pipeline 先完成 authority、Summary、check，再呼叫 publisher。delivery result 不得反向改寫 `deriveCheckState()` 的安全判斷。

- [x] **Step 5: Verify**

Run: `node --test tests/integrations/github-publisher.test.js tests/pipeline.test.js`

Expected: sink failure 只回報 delivery failure，不產生 candidate，也不使 stale result 變 current。

---

## Task N-07: Full E2E、CI Release Gate 與 Operations

**Files:**
- Create: `tests/e2e/adapter-to-github.test.js`
- Create: `fixtures/e2e/mixed-language-complete.json`, `fixtures/e2e/partial-runtime-unknown.json`, `fixtures/e2e/stale-after-restart.json`
- Create: `docs/operations/safety-mvp-next-phase.md`
- Modify: `package.json`, `.github/workflows/review-reduction-safety.yml`
- Modify: `docs/safety-mvp-architecture.md`, `docs/tasks/2026-08-12-safety-mvp.md`

- [x] **Step 1: Create the E2E fixture matrix**

覆蓋 mixed-language complete、single-language partial parse、unknown runtime、adapter timeout、new head before publication、restart old run、GitHub transport failure。

- [x] **Step 2: Write production-path E2E tests**

只透過 `runStoredAdapterPipeline()`、storage port 與 injected GitHub transport；每個 fixture 驗證 candidate、authority、Summary、check 與 delivery result，不直接呼叫 reducer helper。

- [x] **Step 3: Add release commands**

在 `package.json` 保留已於 N-02 建立的遞迴 `test:safety`，並新增：

```json
{
  "test:e2e": "node --test tests/e2e/*.test.js",
  "test:all": "npm run lint && npm run test:safety && npm run test:e2e && npm run test:coverage"
}
```

CI 執行 `npm ci` 後使用 `npm run test:all`，不得透過 path filter 跳過 safety tests。

- [x] **Step 4: Update architecture and operations docs**

記錄 Adapter → normalization → core → CAS store → GitHub sink 的責任邊界、failure reason、retry/idempotency、SQLite backup/cleanup 與 status check 語意；明確說明 `PASS` 只代表 authoritative Summary binding。

- [x] **Step 5: Run final release gate**

Run:

```bash
npm run test:all
git diff --check
```

Expected: lint、unit、coverage、adapter、storage、sink、E2E 全部通過；coverage 維持 lines 90、functions 90、branches 85、statements 90 以上。

---

## Implementation handoff checklist

- [x] review `docs/superpowers/specs/2026-08-12-review-reduction-next-phase-design.md`，並依本次 N-04～N-07 scope 執行。
- [x] N-01～N-03 已完成且其 release gate 通過後開始 N-04～N-07。
- [x] 每次只執行一個 N-task，先寫 failing test 再寫 implementation。
- [x] 新增 reason 前先更新 contract、strategy 與 fixture。
- [x] 每個 task 完成前執行 targeted tests、完整 coverage 與 `git diff --check`。
- [x] 未經明確要求不 commit、不建立 PR、不接真實 GitHub token。
