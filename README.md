# Reviewer — Review Reduction Decision Engine

Reviewer 是一個 deterministic、fail-closed 的 Review Decision Engine。

它的目標不是「替人做完整 Code Review」，而是回答更窄、也更可驗證的問題：

> 在目前可觀測、可驗證的證據下，哪些變更可以安全地 **不選入人工 Review**，哪些仍必須交給人看？

核心決策只有兩類：

```
HUMAN_REVIEW_REQUIRED
NOT_SELECTED_FOR_HUMAN_REVIEW
```

其中 `NOT_SELECTED_FOR_HUMAN_REVIEW` 不是「程式一定沒問題」，而是：

- 分析完整；
- 必要 coverage 完整；
- 沒有 unresolved blocker；
- 沒有 policy / audit 要求人工作業；
- 分析結果與 base/head SHA、Adapter、facts、interpreter identity 完整綁定。

任何 unknown / incomplete / analyzer failure 都採 fail-closed，不能被解讀成安全。

## Current pipeline

```
Git / before-after source
        ↓
Language / Framework Adapter
        ↓
Provider-neutral Semantic Facts
        ↓
Deterministic Domain Interpreters
        ↓
Coverage / Evidence / Impact / Invariants
        ↓
Eligibility
        ↓
Review Scope Reducer
        ↓
HUMAN_REVIEW_REQUIRED
或
NOT_SELECTED_FOR_HUMAN_REVIEW
        ↓
Authoritative Candidate / Summary / Check
```

目前第一個 executable Adapter 是 PHP/Laravel。

## 已實作

- Semantic Fact contract 與 fail-closed ingress
- `semanticFactsDigest`
- versioned Fact Interpreter identity 與 `interpreterSetDigest`
- JSON-safe deterministic Fact properties
- PHP 8.4 CLI analyzer
- Generic facts：
  - `CALL_ARGUMENT_CHANGED`
  - `CALL_REMOVED`
  - `CALL_ADDED`
- 第一批 deterministic PHP/Laravel interpreters：
  - Payment idempotency identity change
  - Transaction boundary removal
  - Authorization guard removal
- persisted authority / stale analysis protection
- Summary / candidate digest binding
- Mutation Evaluation Harness
- Historical PR Evaluation Harness
- provider-neutral GitHub sink boundary

## 目前驗證基準

Mutation corpus：

```
Critical Recall               100.0%
False Negative Rate             0.0%
Critical Direct Fact Coverage  75.0%
Safe Reduction Rate            50.0%
Partial Coverage Rate          50.0%
Analysis Failure Rate           0.0%
Full Review Fallback Rate      50.0%
```

Historical PR evaluator 的 CI pilot：

```
Human Concern Recall          100.0%
Review Scope Reduction         33.3%
Analysis Failure Rate           0.0%
Full Review Rate                0.0%
```

Historical 數字目前來自明確標示的 controlled fixture pilot，只驗證 evaluator wiring，**不代表真實世界 benchmark 已完成**。

## 文件

- [目前能力與四階段實作整理](docs/current-state.md)
- [Safety MVP / Review Decision Engine 架構](docs/safety-mvp-architecture.md)
- [與 Agent Work Harness 的合作方式](docs/integrations/agent-work-harness.md)
- [PR-A：Semantic Fact Ingress](docs/tasks/2026-10-06-semantic-fact-ingress.md)
- [PR-B：PHP/Laravel Adapter](docs/tasks/2026-10-06-php-laravel-adapter.md)
- [PR-C：Mutation Evaluation](docs/tasks/2026-10-06-mutation-evaluation.md)
- [PR-D：Historical PR Evaluation](docs/tasks/2026-10-06-historical-pr-evaluation.md)

## Release gate

```bash
npm run test:all
```

包含：

- lint
- safety tests
- E2E
- coverage
- mutation evaluation
- historical evaluation

## 與 Agent Work Harness 的關係

兩者不互相取代：

```
Agent Work Harness
「這次 agent 工作是否可信地完成？」

Reviewer
「這些完成的變更中，哪些仍需要人工 Review？」
```

建議整合方式：

```
Codex / Claude Code
        ↓
Agent Work Harness
        ↓
Verification SUCCESS
        ↓
Reviewer
        ↓
Review Scope Plan
        ↓
Human / AI Reviewer
```

詳細設計見 [docs/integrations/agent-work-harness.md](docs/integrations/agent-work-harness.md)。

## 目前能力邊界

目前 reduction 應視為 **file-level review scope reduction** 的基礎。

雖然 semantic facts 已有 byte provenance，但 blocker 尚未正式建立：

```
blocker → factId → provenance
```

的完整 region-level selection contract，因此目前不應宣稱能安全縮減到「某檔只有哪幾行需要看」。

後續優先方向：

1. 真實 Historical PR corpus。
2. 增加 PHP/Laravel 支援範圍，降低 `PARTIAL_PARSE`。
3. 提升 Safe Reduction Rate。
4. 建立 multi-file Review Plan / CLI。
5. 再往 region-level review scope 發展。
