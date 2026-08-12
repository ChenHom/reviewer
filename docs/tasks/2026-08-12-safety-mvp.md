# Review Reduction Safety MVP Tasks

Implementation plan: [2026-08-12-review-reduction-safety.md](../superpowers/plans/2026-08-12-review-reduction-safety-mvp.md)

Status: `NOT_STARTED`

## Scope decision

This task list tracks the smallest safe core. It does not attempt full PHP/Laravel parsing, complete mixed-language semantic analysis, LLM reasoning, cross-repository assurance, cache optimization, granular RU review state, or merge-queue support.

The implementation must fail closed. Any unsupported or incomplete analysis becomes Human Review or Full Review fallback and cannot become a reduction-success result.

## Task order

### S-01 — Bootstrap deterministic TypeScript project

- [ ] Create `package.json`, `tsconfig.json`, and `vitest.config.ts`.
- [ ] Add `build`, `test`, and `test:safety` scripts.
- [ ] Add the initial contract smoke test.
- [ ] Verify `npm run build && npm run test:safety`.
- [ ] Commit: `chore: bootstrap safety mvp test harness`.

### S-02 — Define canonical Safety MVP contracts

- [ ] Add `AnalysisIdentity` with repository, base SHA, head SHA, policy identity, and runner version.
- [ ] Add coverage, changed-region, eligibility, reduction, Summary, and publication result types.
- [ ] Add stable reason codes.
- [ ] Reject missing, duplicate, inconsistent, and empty-required-obligation inputs.
- [ ] Add contract tests.
- [ ] Commit: `feat: define safety mvp contracts`.

### S-03 — Implement Coverage / `PARTIAL_PARSE`

- [ ] Add explicit obligation statuses: `COMPLETE`, `PARTIAL_PARSE`, `UNSUPPORTED`, `FAILED`, `TIMEOUT`, `TRUNCATED`.
- [ ] Require one terminal result for every required obligation.
- [ ] Treat only `COMPLETE` as reduction-eligible.
- [ ] Preserve changed byte-region coverage for mixed-language files.
- [ ] Require adapter ID and runtime namespace for each changed region.
- [ ] Add coverage tests for incomplete, unsupported, timeout, truncation, and empty obligations.
- [ ] Commit: `feat: fail closed on incomplete coverage`.

### S-04 — Add runtime context boundary

- [ ] Use canonical runtime namespaces: `server:`, `client:`, `edge:`, `worker:`, `external:`.
- [ ] Reject `unknown` runtime for reduction purposes.
- [ ] Do not introduce a second graph or probabilistic edge model.
- [ ] Add runtime namespace tests.
- [ ] Commit with S-03 if the implementation remains one coverage boundary; otherwise use: `feat: add runtime context coverage contract`.

### S-05 — Implement Eligibility and Reducer

- [ ] Implement `ELIGIBLE`, `NOT_ELIGIBLE`, and `ANALYSIS_FAILED` aggregation.
- [ ] Preserve all eligibility blockers as stable references.
- [ ] Ensure policy requirements cannot override ineligible input.
- [ ] Add the deterministic decision table.
- [ ] Add monotonic property tests: more uncertainty can never reduce Human Review scope.
- [ ] Commit: `feat: add fail-closed eligibility reducer`.

### S-06 — Create production runner and vertical fixtures

- [ ] Add the production runner used by all fixture tests.
- [ ] Create `human-review-required.json`.
- [ ] Create `not-selected.json`.
- [ ] Create `analysis-failure.json`.
- [ ] Create `stale-run.json`.
- [ ] Assert exact decision, fallback, reasons, and SHA in vertical tests.
- [ ] Commit: `test: add safety mvp vertical fixtures`.

### S-07 — Protect current authoritative analysis

- [ ] Implement candidate validation before publication.
- [ ] Compare full `AnalysisIdentity` with current repository state.
- [ ] Reject old head SHA, old policy identity, and old runner identity.
- [ ] Ensure rejected candidates do not mutate current result.
- [ ] Test newer result followed by late old result.
- [ ] Commit: `feat: protect authoritative analysis publication`.

### S-08 — Bind Summary and status check

- [ ] Generate one Summary payload from the authoritative result.
- [ ] Include repository, base SHA, head SHA, decision, coverage, reasons, fallback, and identity.
- [ ] Make Summary publication failure fail the reduction check.
- [ ] Make SHA mismatch fail the reduction check.
- [ ] Ensure analysis failure is unavailable/failure, never reduction success.
- [ ] Commit: `feat: bind reduction check to authoritative summary`.

### S-09 — Add end-to-end regression cases

- [ ] Test new commit invalidating previous authority immediately.
- [ ] Test analyzer failure fallback.
- [ ] Test old run completing after a newer run.
- [ ] Test stale Summary cannot be reported as current.
- [ ] Commit: `test: cover stale and failed analysis paths`.

### S-10 — Add deterministic CI release gate

- [ ] Add `.github/workflows/review-reduction-safety.yml`.
- [ ] Run `npm ci`, `npm run build`, and `npm run test:safety`.
- [ ] Ensure required tests do not depend on LLM, external network, or repository scripts.
- [ ] Ensure the workflow cannot silently disappear through path filtering.
- [ ] Verify the complete local suite.
- [ ] Commit: `test: enforce safety mvp release gate`.

## Completion criteria

- [ ] Coverage uncertainty cannot produce reduction authority.
- [ ] Reducer decisions are deterministic and property-tested.
- [ ] Both required decision branches pass through the production runner.
- [ ] Stale and late results cannot overwrite current authority.
- [ ] Summary and status check are bound to the same identity.
- [ ] Failure and missing publication paths are fail-closed.
- [ ] `npm run build && npm run test:safety` passes without network or LLM access.

## Deferred after Safety MVP

- Full PHP/Laravel parser and framework adapter.
- Complete Blade/Vue/JSX nested-language semantic analysis.
- LLM hypothesis generation and RU wording.
- External-authority invariant model.
- Cross-repository assurance.
- Incremental cache and advanced cost optimization.
- Granular RU reconciliation.
- Merge queue support.
