# Current State — Review Reduction Decision Engine

本文整理 2026-10-06 完成並合入 `master` 的四個階段，以及目前產品真正具備的能力、限制與下一步。

## 1. 四階段實作

### PR-A — Semantic Fact Ingress + Analysis Context Hardening

目的：建立 Adapter 與 Review Decision Engine 之間的可信資料邊界。

已完成：

- `semantic-facts` Adapter capability。
- provider-neutral Fact envelope：
  - `id`
  - `kind`
  - `subject`
  - `properties`
  - byte provenance
  - source adapter identity/version
- Fact 未被 trusted interpreter 處理時，產生 `FACT_UNHANDLED:<id>`。
- interpreter exception / invalid output 採 fail-closed。
- Fact properties 必須是 deterministic JSON-safe value。
- semantic facts canonicalize 後綁入 `AnalysisContextBinding`。
- `semanticFactsDigest`。
- interpreter 必須是具 identity 的 descriptor：

```js
{
  id: 'payment-policy',
  version: '1.0.0',
  interpret(fact, context) {
    // ...
  }
}
```

- `interpreterSetDigest`。
- Candidate / Summary digest 對 facts 與 fact assessment 敏感。

因此以下兩種情況都不得共用 authoritative result：

```
相同 base/head SHA + 不同 semantic facts
相同 base/head SHA + 不同 interpreter id/version
```

### PR-B — Real PHP/Laravel Adapter + Deterministic Interpreters

目的：開始從真實程式碼產生 machine facts，而不是只使用 fixture。

架構：

```
Node Reviewer
    │
    ├─ spawn PHP CLI
    ▼
PHP Analyzer
    │ token_get_all(..., TOKEN_PARSE)
    ▼
Generic Semantic Facts
    ▼
PHP/Laravel Domain Interpreters
```

PR-B 完成時 Adapter 輸出的 generic facts（之後 analyzer 已改用 PHP-Parser AST，並增加運算子、guard、陣列元素、字面值、條件反轉、回傳值、參數順序、變數等 facts；目前完整清單見 [README「已實作」](../README.md#已實作)）：

- `CALL_ARGUMENT_CHANGED`
- `CALL_REMOVED`
- `CALL_ADDED`

Domain interpreter 再把 generic facts 解讀成 domain blockers：

```
CALL_ARGUMENT_CHANGED
argument=idempotencyKey
        ↓
PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED
```

```
CALL_REMOVED
callee=DB::transaction
        ↓
TRANSACTION_BOUNDARY_REMOVED
```

```
CALL_REMOVED
callee=$this->authorize / Gate::authorize
        ↓
AUTHORIZATION_GUARD_REMOVED
```

這個分層很重要：

> Adapter 描述「發生了什麼」；Interpreter 才描述「這件事對 Review policy 代表什麼」。

Adapter 不直接輸出 `HUMAN_REVIEW_REQUIRED` 或 `NOT_SELECTED_FOR_HUMAN_REVIEW`。

### PR-C — Mutation Evaluation Harness

目的：避免只靠「CI 綠」宣稱安全，而是直接量測 reduction safety。

目前 corpus 包含：

Critical：

- Payment idempotency argument change。
- Transaction boundary removed。
- Authorization guard removed。
- wallet condition `< → <=` 的 unsupported mutation。

Safe：

- formatting/comment-only。
- local variable rename。

每個 case 都走 production pipeline：

```
PHP Adapter
→ Fact Ingress
→ Production Domain Interpreters
→ Coverage
→ Eligibility
→ Reducer
```

目前 baseline：

```
Critical Recall               100.0%
False Negative Rate             0.0%
Critical Direct Fact Coverage  75.0%
Safe Reduction Rate            50.0%
Partial Coverage Rate          50.0%
Analysis Failure Rate           0.0%
Full Review Fallback Rate      50.0%
```

解讀：

- curated critical mutation 目前沒有 false negative。
- 仍有 25% critical case 是靠 fail-closed fallback，而不是 analyzer 直接理解。
- safe case 只有一半能 reduction。
- 現階段保守性仍高，不能只看 Critical Recall = 100%。

### PR-D — Historical PR Evaluation

目的：驗證 reduction 是否仍覆蓋實際 Human Review concern。

Snapshot manifest 包含：

- repository
- base SHA
- head SHA
- changed files before/after
- human concern ground truth

重要規則：

> `humanConcerns` 只在分析完成後比較，絕不傳入 Adapter / Interpreter，避免 ground-truth leakage。

目前指標：

- Human Concern Recall
- Review Scope Reduction
- Analysis Failure Rate
- Full Review Rate

CI pilot：

```
Changed files                3
Selected files               2
Human concerns               2
Human concerns covered       2
Human concerns missed        0

Human Concern Recall        100.0%
Review Scope Reduction       33.3%
Analysis Failure Rate         0.0%
Full Review Rate              0.0%
```

目前 pilot 是 controlled fixture，只證明 evaluation wiring 正常。下一步應加入真正 Historical PR snapshots。

## 2. 現在的完整 Pipeline

```
Change
  ↓
PHP/Laravel Adapter
  ├─ changed regions
  ├─ runtime context
  └─ semantic facts
  ↓
AnalysisContextBinding
  ├─ adapterSetDigest
  ├─ executionContextDigest
  ├─ semanticFactsDigest
  └─ interpreterSetDigest
  ↓
Domain Interpreters
  ↓
Coverage / Evidence / Impact / Invariants / Risk Blockers
  ↓
Eligibility
  ↓
Review Scope Reducer
  ↓
HUMAN_REVIEW_REQUIRED
或
NOT_SELECTED_FOR_HUMAN_REVIEW
  ↓
CAS Authority
  ↓
Summary / Status Check
```

## 3. 目前 Safety Invariants

1. `NOT_SELECTED_FOR_HUMAN_REVIEW` 只能來自完整有效分析。
2. Unknown != Safe。
3. `PARTIAL_PARSE`、timeout、unsupported、truncation、analyzer failure 不能被視為沒有風險。
4. Adapter 不能直接決定 Review outcome。
5. Fact interpreter 未處理的 fact 不得靜默消失。
6. Facts / interpreter identity 都是 analysis context 的一部分。
7. 新 head SHA 必須使舊結果 stale。
8. 舊 run 不得覆寫新 authoritative result。
9. Summary 必須綁定 authoritative candidate。
10. Evaluation 中 critical false negative 必須使 gate fail。

## 4. 目前適合拿來做什麼

現階段適合：

- PHP/Laravel PR 的 deterministic fact extraction。
- 對支援的 semantic change 做 fail-closed Review selection。
- 建立 file-level Review Scope。
- 在 CI / GitHub Summary 顯示：
  - 哪些檔案必須 Human Review。
  - 哪些檔案沒有被選入 Human Review。
  - reduction 比例。
- 用 mutation/historical corpus 持續校準 reduction safety。

目前不應宣稱：

- 能做完整 PHP AST / symbol solving。
- 能理解所有 Laravel runtime behavior。
- 能安全處理所有語言。
- 已有真實世界 false-negative 保證。
- 能做成熟的 line-level / region-level review reduction。

## 5. 接下來優先順序

優先順序應以「提高 reduction，但不傷害 critical recall」為核心：

```
1. 真實 Historical PR corpus
2. 擴大 PHP/Laravel analyzer coverage
3. 增加 deterministic domain interpreters
4. multi-file Review Plan / CLI
5. GitHub PR workflow
6. Harness integration
7. region-level selection
8. optional impact provider / code-review-graph
9. 最後才考慮 LLM hypothesis layer
```

核心目標函數：

```
maximize Review Scope Reduction
subject to Critical False Negative ≈ 0
```

不能反過來為了 reduction 數字，降低 fail-closed 邊界。
