# Review Reduction Safety MVP Tasks

Implementation plan: [2026-08-12-review-reduction-safety.md](../superpowers/plans/2026-08-12-review-reduction-safety-mvp.md)

Status: `IMPLEMENTED`

Production entrypoint: `src/runner.js` → `runSafetyMvp()`. `runAnalysis()` remains the analysis-only stage used inside that pipeline.

Testing strategy: [Safety MVP 測試策略](../testing/safety-mvp-test-strategy.md). Every new behavior must cover positive, negative, boundary, and integration cases; run `npm run lint`, `npm run test:safety`, and `npm run test:coverage`.

Next phase roadmap: [Review Reduction Next Phase Tasks](./2026-08-12-review-reduction-next-phase.md).

The first baseline intentionally uses Node.js native ESM and `node:test` with no runtime dependencies. TypeScript/Vitest are deferred until the core needs a larger public API or external adapters.

## Scope decision

This task list tracks the smallest safe core. It does not attempt full PHP/Laravel parsing, complete mixed-language semantic analysis, LLM reasoning, cross-repository assurance, cache optimization, granular RU review state, or merge-queue support.

The implementation must fail closed. Any unsupported or incomplete analysis becomes Human Review or Full Review fallback and cannot become a reduction-success result.

## Task order

### S-01 — Bootstrap deterministic Node project

- [x] Create `package.json` and `.gitignore`.
- [x] Add `test` and `test:safety` scripts.
- [x] Add the initial contract smoke test.
- [x] Verify `npm run test:safety`.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-02 — Define canonical Safety MVP contracts

- [x] Add `AnalysisIdentity` with repository, base SHA, head SHA, policy identity, and runner version.
- [x] Add coverage, changed-region, eligibility, reduction, Summary, and publication result types.
- [x] Add stable reason codes.
- [x] Reject missing, duplicate, inconsistent, and empty-required-obligation inputs.
- [x] Add contract tests.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-03 — Implement Coverage / `PARTIAL_PARSE`

- [x] Add explicit complete/incomplete/failed obligation outcomes with reason codes including `PARTIAL_PARSE`.
- [x] Require one terminal result for every required obligation.
- [x] Treat only `COMPLETE` as reduction-eligible.
- [x] Preserve changed byte-region coverage for mixed-language files.
- [x] Require adapter ID and runtime namespace for each changed region.
- [x] Add coverage tests for partial parse, unknown runtime, and empty obligations.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-04 — Add runtime context boundary

- [x] Use explicit runtime context on changed regions.
- [x] Reject `unknown` runtime for reduction purposes.
- [x] Do not introduce a second graph or probabilistic edge model.
- [x] Add runtime context tests.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-05 — Implement Eligibility and Reducer

- [x] Implement `ELIGIBLE`, `NOT_ELIGIBLE`, and `ANALYSIS_FAILED` aggregation.
- [x] Preserve all eligibility blockers as stable references.
- [x] Ensure policy requirements cannot override ineligible input.
- [x] Add the deterministic decision table.
- [x] Add monotonic property tests: more uncertainty can never reduce Human Review scope.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-06 — Create production runner and vertical fixtures

- [x] Add the production runner used by all fixture tests.
- [x] Create `human-review-required.json`.
- [x] Create `not-selected.json`.
- [x] Assert exact decision, fallback, reasons, and SHA in vertical tests.
- [x] Cover analysis failure in the vertical test.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-07 — Protect current authoritative analysis

- [x] Implement candidate validation before publication.
- [x] Compare full `AnalysisIdentity` with current repository state.
- [x] Reject old head SHA, old policy identity, and old runner identity.
- [x] Ensure rejected candidates do not mutate current result.
- [x] Test newer result followed by late old result.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-08 — Bind Summary and status check

- [x] Generate one Summary payload from the authoritative result.
- [x] Include repository, base SHA, head SHA, decision, coverage, reasons, fallback, and identity.
- [x] Make Summary publication failure fail the reduction check.
- [x] Make SHA mismatch fail the reduction check.
- [x] Ensure analysis failure is failure, never reduction success.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-09 — Add end-to-end regression cases

- [x] Test new commit invalidating previous authority immediately.
- [x] Test analyzer failure fallback.
- [x] Test old run completing after a newer run.
- [x] Test stale Summary cannot be reported as current.
- [x] Add analysis-failure and stale-run JSON fixtures for the regression paths.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-10 — Add deterministic CI release gate

- [x] Add `.github/workflows/review-reduction-safety.yml`.
- [x] Run `npm ci` and `npm run test:safety`.
- [x] Ensure required tests do not depend on LLM, external network, or repository scripts.
- [x] Ensure the workflow cannot silently disappear through path filtering.
- [x] Verify the complete local suite.
- [x] Commit: Safety MVP implementation committed in this branch.

### S-11 — Harden test completeness and regression safety

- [x] 記錄正向、反向、邊界、property/invariant 與 vertical/E2E 測試規範。
- [x] 補齊 Contracts、Coverage、Reducer、Publication、Summary 的矩陣測試。
- [x] 補齊 PARTIAL_PARSE、UNSUPPORTED、TIMEOUT、TRUNCATED 與 analysis failure fixtures。
- [x] Coverage range 對負值、零長度、逆序、重疊、未排序與相鄰邊界 fail-closed。
- [x] `npm run lint`、`npm run test:safety`、`npm run test:coverage` 全部通過。

## Completion criteria

- [x] Coverage uncertainty cannot produce reduction authority.
- [x] Reducer decisions are deterministic and property-tested.
- [x] Both required decision branches pass through the production runner.
- [x] Stale and late results cannot overwrite current authority.
- [x] Summary and status check are bound to the same identity.
- [x] Failure and missing publication paths are fail-closed.
- [x] `npm run test:safety` passes without network or LLM access.
- [x] 後續測試必須遵守 [Safety MVP 測試策略](../testing/safety-mvp-test-strategy.md) 與 coverage gate。

## Deferred after Safety MVP

- Full PHP/Laravel parser and framework adapter.
- Complete Blade/Vue/JSX nested-language semantic analysis.
- LLM hypothesis generation and RU wording.
- External-authority invariant model.
- Cross-repository assurance.
- Incremental cache and advanced cost optimization.
- Granular RU reconciliation.
- Merge queue support.
