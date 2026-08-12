# Review Reduction Safety MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a conservative, deterministic Safety MVP that can only reduce Human Review when analysis coverage, eligibility, current SHA identity, and publication state are authoritative.

**Architecture:** Keep the first implementation independent from language parsers, LLMs, and GitHub APIs. A small TypeScript core consumes normalized coverage and risk inputs, evaluates fail-closed eligibility, produces a candidate result, validates its `AnalysisIdentity`, and publishes one authoritative result only after the Summary contract is satisfied. Fixture and property tests exercise the same production runner used by later CI integration.

**Tech Stack:** Node.js, TypeScript, npm, Vitest, JSON fixtures, and GitHub Actions. Required tests are deterministic and do not use an LLM, network, repository scripts, or external analyzer processes.

---

## Scope

This MVP includes:

- Coverage obligations with explicit `COMPLETE`, `PARTIAL_PARSE`, `UNSUPPORTED`, `FAILED`, `TIMEOUT`, and `TRUNCATED` outcomes.
- Changed-region language ownership for mixed-language files.
- Runtime context represented through canonical ID namespaces such as `server:`, `client:`, `edge:`, `worker:`, and `external:`; no new `EntityKind` is introduced.
- Deterministic `ELIGIBLE`, `NOT_ELIGIBLE`, and `ANALYSIS_FAILED` results.
- Reducer behavior that preserves every blocker and never allows policy to override an ineligible result.
- Two vertical fixtures: one `HUMAN_REVIEW_REQUIRED`, one `NOT_SELECTED_FOR_HUMAN_REVIEW`.
- Analysis identity, stale-run rejection, atomic candidate publication, Summary publication, and status-check binding.
- End-to-end tests for new head SHA, analyzer failure, and late completion of an old run.

This MVP does not include full PHP/Laravel parsing, complete mixed-language semantic extraction, LLM hypothesis generation, cross-repository assurance, incremental cache optimization, granular RU review state, or merge-queue support.

Unsupported language regions, runtime contexts, or analyzer capabilities must produce an incomplete result and retain Human Review; they must never silently become reduction candidates.

## File Map

Create the following files:

- `package.json` — scripts and minimal development dependencies.
- `tsconfig.json` — strict TypeScript compilation settings.
- `vitest.config.ts` — deterministic test configuration.
- `src/contracts.ts` — canonical Safety MVP types and stable reason codes.
- `src/coverage.ts` — coverage obligation evaluation and changed-region language validation.
- `src/reducer.ts` — eligibility aggregation and deterministic reduction decision.
- `src/publication.ts` — `AnalysisIdentity`, current-head validation, stale-run rejection, and atomic publication boundary.
- `src/summary.ts` — authoritative Summary payload and status-check state derivation.
- `src/runner.ts` — production runner that executes the complete deterministic pipeline for normalized inputs.
- `src/index.ts` — public exports for the core runner.
- `tests/contracts.test.ts` — contract validation and invalid-state tests.
- `tests/coverage.test.ts` — coverage, partial-parse, unsupported-language, and runtime-namespace tests.
- `tests/reducer.test.ts` — eligibility/reducer decision table and monotonic property tests.
- `tests/publication.test.ts` — identity, stale-run, atomic publication, and failure tests.
- `tests/summary.test.ts` — Summary/check binding tests.
- `tests/vertical.test.ts` — end-to-end fixture assertions.
- `fixtures/safety-mvp/human-review-required.json` — complete analysis with a blocking risk or incomplete required coverage.
- `fixtures/safety-mvp/not-selected.json` — complete analysis with no applicable blockers.
- `fixtures/safety-mvp/analysis-failure.json` — evaluator failure that cannot produce an authoritative result.
- `fixtures/safety-mvp/stale-run.json` — an older run attempting to publish after the current head changed.
- `.github/workflows/review-reduction-safety.yml` — deterministic required test workflow; it must not invoke an LLM or external network.

## Canonical Contracts

`src/contracts.ts` must define these shapes before pipeline behavior is implemented:

```ts
export type CoverageStatus =
  | 'COMPLETE'
  | 'PARTIAL_PARSE'
  | 'UNSUPPORTED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'TRUNCATED';

export type RuntimeNamespace =
  | 'server'
  | 'client'
  | 'edge'
  | 'worker'
  | 'external'
  | 'unknown';

export interface AnalysisIdentity {
  repository: string;
  baseSha: string;
  headSha: string;
  policyId: string;
  policyVersion: string;
  runnerVersion: string;
}

export interface ChangedRegion {
  path: string;
  startByte: number;
  endByte: number;
  language: string;
  adapterId: string;
  runtime: RuntimeNamespace;
}

export interface CoverageObligation {
  id: string;
  required: boolean;
  status: CoverageStatus;
  changedRegions: ChangedRegion[];
  reasonCode?: string;
}

export interface CoverageReport {
  obligations: CoverageObligation[];
}

export type EligibilityResult =
  | { status: 'ELIGIBLE'; blockingSources: [] }
  | { status: 'NOT_ELIGIBLE'; blockingSources: string[] }
  | { status: 'ANALYSIS_FAILED'; blockingSources: string[] };

export type ReductionDecision =
  | { status: 'NOT_SELECTED_FOR_HUMAN_REVIEW'; reasons: string[] }
  | { status: 'HUMAN_REVIEW_REQUIRED'; reasons: string[]; fallback: 'TARGETED' | 'FULL' };
```

The implementation must validate these invariants:

- `ELIGIBLE` has no blockers.
- `NOT_ELIGIBLE` has at least one stable blocker.
- `ANALYSIS_FAILED` never produces a reduction-success status.
- Every required coverage obligation has a terminal result.
- Any required result other than `COMPLETE` blocks reduction.
- Unknown, missing, duplicate, or inconsistent inputs fail closed.
- Blocker order is semantic-set order; serializers canonicalize it before comparison.

### Task 1: Bootstrap the deterministic TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `tests/contracts.test.ts`

- [ ] **Step 1: Add package metadata and scripts**

Use these scripts:

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:safety": "vitest run tests/contracts.test.ts tests/coverage.test.ts tests/reducer.test.ts tests/publication.test.ts tests/summary.test.ts tests/vertical.test.ts"
  }
}
```

- [ ] **Step 2: Configure strict compilation and deterministic Vitest execution**

`tsconfig.json` must enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`.

- [ ] **Step 3: Add the first contract test and run it**

Run: `npm test -- tests/contracts.test.ts`

Expected: the test runner starts and the initial contract test passes.

- [ ] **Step 4: Run the baseline checks**

Run: `npm run build && npm run test:safety`

Expected: PASS with no source implementation beyond the contract smoke test.

- [ ] **Step 5: Commit the project bootstrap**

```bash
git add package.json tsconfig.json vitest.config.ts src/index.ts tests/contracts.test.ts
git commit -m "chore: bootstrap safety mvp test harness"
```

### Task 2: Implement canonical contracts and validation

**Files:**
- Create: `src/contracts.ts`
- Modify: `src/index.ts`
- Modify: `tests/contracts.test.ts`

- [ ] **Step 1: Write invalid-state tests**

Cover missing required obligations, duplicate obligation IDs, `ELIGIBLE` with blockers, `NOT_ELIGIBLE` without blockers, and `ANALYSIS_FAILED` with an empty diagnostic list.

- [ ] **Step 2: Run the contract tests and verify failure**

Run: `npm test -- tests/contracts.test.ts`

Expected: FAIL because the contract validator does not exist.

- [ ] **Step 3: Implement the types, reason codes, and validator**

Expose a pure `validateAnalysisInput(input)` function. It must return structured validation errors, never throw for expected invalid input, and must not infer missing coverage as complete.

- [ ] **Step 4: Run contract tests and compilation**

Run: `npm test -- tests/contracts.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit the canonical contracts**

```bash
git add src/contracts.ts src/index.ts tests/contracts.test.ts
git commit -m "feat: define safety mvp contracts"
```

### Task 3: Implement coverage and mixed-language fail-closed behavior

**Files:**
- Create: `src/coverage.ts`
- Modify: `tests/coverage.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write coverage tests**

Cover these cases:

```text
all required regions COMPLETE              -> reduction may continue
one region PARTIAL_PARSE                   -> reduction blocked
unsupported language in changed byte range -> reduction blocked
timeout / failure / truncation             -> reduction blocked
empty required obligation set               -> invalid input, not COMPLETE
unknown runtime namespace                   -> explicit blocker
```

- [ ] **Step 2: Run the coverage tests and verify failure**

Run: `npm test -- tests/coverage.test.ts`

Expected: FAIL because coverage evaluation is not implemented.

- [ ] **Step 3: Implement `evaluateCoverage`**

The function must:

- require exactly one terminal result per required obligation;
- treat only `COMPLETE` as reduction-eligible;
- retain region-level `PARTIAL_PARSE` rather than collapsing it into file-level success;
- validate changed byte ranges are non-negative and ordered;
- require an adapter and runtime namespace for every changed region;
- return stable blocker IDs for every failed required obligation.

- [ ] **Step 4: Add canonical runtime namespace checks**

Use the existing opaque entity ID convention for semantic entities and require runtime prefixes in adapter output. Do not add a second runtime graph or probabilistic edge model.

- [ ] **Step 5: Run coverage tests and compilation**

Run: `npm test -- tests/coverage.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit coverage safety behavior**

```bash
git add src/coverage.ts src/index.ts tests/coverage.test.ts
git commit -m "feat: fail closed on incomplete coverage"
```

### Task 4: Implement Eligibility and Reducer decision logic

**Files:**
- Create: `src/reducer.ts`
- Modify: `tests/reducer.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the decision table tests**

The table must assert:

```text
ANALYSIS_FAILED                         -> HUMAN_REVIEW_REQUIRED / FULL
NOT_ELIGIBLE with coverage blocker      -> HUMAN_REVIEW_REQUIRED / FULL
NOT_ELIGIBLE with risk blocker          -> HUMAN_REVIEW_REQUIRED / TARGETED
ELIGIBLE with no requiring policy       -> NOT_SELECTED_FOR_HUMAN_REVIEW
ELIGIBLE with audit candidate           -> HUMAN_REVIEW_REQUIRED / TARGETED
policy cannot override an ineligible result
all blocker references are preserved
```

- [ ] **Step 2: Add monotonic property tests**

For every valid input, adding an unresolved blocker, changing `COMPLETE` to a non-complete status, or removing required evidence must never change a Human Review result into `NOT_SELECTED_FOR_HUMAN_REVIEW`.

- [ ] **Step 3: Run reducer tests and verify failure**

Run: `npm test -- tests/reducer.test.ts`

Expected: FAIL because the decision functions do not exist.

- [ ] **Step 4: Implement `evaluateEligibility` and `reduceReviewScope`**

Keep both functions deterministic and side-effect free. The reducer must consume authoritative eligibility blockers and may add policy requirements, but it may not remove or override blockers.

- [ ] **Step 5: Run reducer tests and build**

Run: `npm test -- tests/reducer.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit the reducer**

```bash
git add src/reducer.ts src/index.ts tests/reducer.test.ts
git commit -m "feat: add fail-closed eligibility reducer"
```

### Task 5: Add production runner and vertical fixtures

**Files:**
- Create: `src/runner.ts`
- Create: `fixtures/safety-mvp/human-review-required.json`
- Create: `fixtures/safety-mvp/not-selected.json`
- Create: `fixtures/safety-mvp/analysis-failure.json`
- Create: `fixtures/safety-mvp/stale-run.json`
- Modify: `tests/vertical.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Define fixture input and expected output schemas**

Each fixture must include an `AnalysisIdentity`, coverage obligations, risk blockers, policy requirements, and an exact expected decision. Expected output must include the decision status, fallback mode, reason codes, and current SHA.

- [ ] **Step 2: Create the `HUMAN_REVIEW_REQUIRED` fixture**

Use a changed region with a valid high-impact risk and missing concurrency evidence, or an incomplete required coverage obligation. The expected result must retain the blocker and select targeted or full review as appropriate.

- [ ] **Step 3: Create the `NOT_SELECTED_FOR_HUMAN_REVIEW` fixture**

Use complete coverage, no applicable risk case, no required policy rule, and no audit selection. The expected result must be `NOT_SELECTED_FOR_HUMAN_REVIEW` with explicit reduction reasons.

- [ ] **Step 4: Create failure and stale-run fixtures**

The failure fixture must not produce an authoritative eligibility result. The stale fixture must be rejected when its head SHA differs from the current repository head.

- [ ] **Step 5: Implement the production runner**

The runner must execute validation, coverage evaluation, eligibility, reduction, and result serialization in one deterministic path. Tests must call this runner rather than duplicate decision logic.

- [ ] **Step 6: Run the vertical tests**

Run: `npm test -- tests/vertical.test.ts`

Expected: PASS for both decision branches, analysis failure fallback, and stale-run rejection.

- [ ] **Step 7: Commit the fixtures and runner**

```bash
git add src/runner.ts src/index.ts fixtures/safety-mvp tests/vertical.test.ts
git commit -m "test: add safety mvp vertical fixtures"
```

### Task 6: Implement current authority and atomic publication

**Files:**
- Create: `src/publication.ts`
- Modify: `tests/publication.test.ts`
- Modify: `src/runner.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write publication tests**

Cover:

```text
matching repository/base/head/policy identity -> publish accepted
new current head                                 -> old candidate rejected as STALE
different policy or runner version               -> candidate rejected
partial candidate result                         -> publication rejected
late old run after new result                    -> current result unchanged
analysis failure                                 -> no reduction-success publication
```

- [ ] **Step 2: Run publication tests and verify failure**

Run: `npm test -- tests/publication.test.ts`

Expected: FAIL because the authority boundary does not exist.

- [ ] **Step 3: Implement `publishCandidate`**

The function must validate the complete candidate, compare its identity with the current head, and perform one final state replacement. A rejected candidate must return a stable rejection reason and must not mutate the current authoritative result.

- [ ] **Step 4: Test the late-run sequence**

Run the sequence `publish(A)`, update current head to `B`, attempt `publish(A)`, then `publish(B)`. Assert that `B` is the only authoritative result.

- [ ] **Step 5: Run publication tests and build**

Run: `npm test -- tests/publication.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit the authority boundary**

```bash
git add src/publication.ts src/runner.ts src/index.ts tests/publication.test.ts
git commit -m "feat: protect authoritative analysis publication"
```

### Task 7: Bind Summary publication to the status check

**Files:**
- Create: `src/summary.ts`
- Modify: `tests/summary.test.ts`
- Modify: `src/publication.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write Summary/check tests**

Assert:

```text
authoritative result + successful Summary publication -> PASS
Summary publication failure                         -> FAILURE
missing Summary                                     -> FAILURE
Summary SHA differs from result SHA                 -> FAILURE
analysis failure                                    -> FAILURE / UNAVAILABLE
stale candidate                                     -> no PASS
```

- [ ] **Step 2: Implement the Summary payload**

The payload must include current repository, base SHA, head SHA, decision status, reason codes, review units or fallback scope, coverage status, and publication identity.

- [ ] **Step 3: Implement `deriveCheckState`**

`PASS` is allowed only when the result is authoritative for the current head and the Summary has been published successfully for that same identity. A reduction decision must never hide an unavailable analysis.

- [ ] **Step 4: Run Summary tests and build**

Run: `npm test -- tests/summary.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit Summary/check binding**

```bash
git add src/summary.ts src/publication.ts src/index.ts tests/summary.test.ts
git commit -m "feat: bind reduction check to authoritative summary"
```

### Task 8: Add end-to-end safety regression coverage and CI

**Files:**
- Modify: `tests/vertical.test.ts`
- Create: `.github/workflows/review-reduction-safety.yml`
- Modify: `package.json`

- [ ] **Step 1: Add the new-head sequence test**

Assert that a new head immediately invalidates the previous authority before the new analysis completes, and that the old Summary cannot be reported as current.

- [ ] **Step 2: Add analyzer-failure fallback test**

Force a required evaluator to return `FAILED` and assert that the runner returns unavailable/full-review fallback, never `NOT_SELECTED_FOR_HUMAN_REVIEW`.

- [ ] **Step 3: Add late-run overwrite regression test**

Run a newer candidate to publication before an older candidate and assert that the older candidate cannot replace the newer authoritative result.

- [ ] **Step 4: Add deterministic CI workflow**

The workflow must run `npm ci`, `npm run build`, and `npm run test:safety`. It must not have path conditions that silently remove the required check, and it must not require LLM or external network access.

- [ ] **Step 5: Run the complete verification suite**

Run: `npm run build && npm run test:safety`

Expected: PASS with both vertical branches and all stale/failure regressions.

- [ ] **Step 6: Commit the release gate**

```bash
git add tests/vertical.test.ts .github/workflows/review-reduction-safety.yml package.json
git commit -m "test: enforce safety mvp release gate"
```

## Release Gate

The Safety MVP is complete only when all of the following are true:

- Required coverage cannot become `COMPLETE` through an empty set, missing result, unsupported adapter, timeout, truncation, or partial parse.
- Every `NOT_ELIGIBLE` result has stable blockers, and every `ANALYSIS_FAILED` result prevents reduction success.
- Reducer property tests prove that adding uncertainty never reduces Human Review scope.
- Both `HUMAN_REVIEW_REQUIRED` and `NOT_SELECTED_FOR_HUMAN_REVIEW` fixtures pass through the production runner.
- An old SHA, old policy, old runner, or late run cannot publish over the current authoritative result.
- Summary publication and status check use the same AnalysisIdentity.
- Analysis failure and missing Summary produce failure/unavailable, not a green reduction check.
- `npm run build && npm run test:safety` passes without network or LLM dependencies.

