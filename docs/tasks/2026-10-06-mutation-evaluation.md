# PR-C — Mutation Evaluation Harness

Status: `IMPLEMENTED`

> 歷史紀錄：本文記錄 PR-C 合入 `master` 時（2026-10-06）的設計與初始 corpus，之後不再更新。目前的 corpus 與 baseline 見 [README「目前驗證基準」](../../README.md#目前驗證基準) 與 [Current State](../current-state.md)。

Base: PR-B `feat/php-laravel-adapter`

## Goal

建立可重跑的 mutation benchmark，量測目前 PHP/Laravel Adapter + Safety MVP 是否真的能在「不漏掉 critical mutation」的前提下減少人工 Review。

## Scope

- 建立 manifest-driven mutation corpus。
- 每個 case 都走 production：
  `PHP Adapter → Fact ingress → production domain interpreters → coverage → eligibility → reducer`。
- 不注入測試專用 decision shortcut。
- 輸出：
  - Critical Recall
  - False Negative Rate
  - Critical Direct Fact Coverage
  - Safe Reduction Rate
  - Partial Coverage Rate
  - Analysis Failure Rate
  - Full Review Fallback Rate
- Critical Recall 與 semantic fact detection 分開計算，避免把純 fail-closed fallback 誤當成 analyzer 理解能力。
- Critical false negative 會使 evaluation command exit non-zero。
- expected fact 消失或既有 decision 行為漂移會使 regression gate 失敗。

## Initial corpus

Critical:

- MUT-001 — payment idempotency named argument change。
- MUT-002 — transaction boundary removed。
- MUT-003 — authorization guard removed。
- MUT-004 — wallet balance condition `< → <=`；PR-C 當時刻意維持 unsupported，用來量測 fallback-only safety。之後已改由 `BINARY_OPERATOR_CHANGED` → `COMPARISON_OPERATOR_CHANGED` 直接偵測。

Safe:

- SAFE-001 — formatting/comment-only。
- SAFE-002 — local variable rename，語意安全但 PR-C 當時 analyzer 尚未支援，用來量測 reduction miss。加入 scope-aware 區域變數改名後已可 reduce（預期 `NOT_SELECTED_FOR_HUMAN_REVIEW`）。

截至 2026-10-07，corpus 已擴充為 MUT-001～MUT-016、SAFE-001～SAFE-004，見 `evaluation/mutations/cases.json`；目前數字見 [README「目前驗證基準」](../../README.md#目前驗證基準)。

## Interpreter Profile

Evaluation 會使用 PR-B 的 `PHP_LARAVEL_DOMAIN_INTERPRETERS`，並將同一組 interpreter identity/version 綁進 AnalysisContextBinding。這可避免 benchmark 只靠 `FACT_UNHANDLED` 保守擋住，而沒有真正測到 domain interpretation。

## Interpretation

`Critical Recall = 100%` 只代表目前 corpus 中所有 critical mutation 都仍要求 Human Review。

它不等於 analyzer 已理解所有 critical mutation。

因此同時觀察：

`Critical Direct Fact Coverage`

若 critical case 只因 `PARTIAL_PARSE` 被 Full Review 擋住，會計入 recall，但不計入 direct fact coverage。

## Gate

目前 release gate 新增：

```bash
npm run eval:mutations
```

CI 失敗條件：

- critical mutation 產生 `NOT_SELECTED_FOR_HUMAN_REVIEW`
- 已知 expected semantic fact 消失
- current decision regression
- pipeline publication failure

Safe Reduction Rate 不設硬門檻；它是後續優化目標。

## Out of scope

- Historical PR benchmark。
- Domain risk/invariant interpreter。
- LLM。
- 大型 repository 效能。
- 統計顯著性或真實世界 false-negative 保證。

## Next

下一階段應先補 PR-A 的 fact/interpreter identity binding，再增加 domain interpreter；之後才進 Historical PR Evaluation。
