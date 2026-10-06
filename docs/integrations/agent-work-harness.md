# Agent Work Harness Integration

本文定義 Reviewer 與 `ChenHom/agent-work-harness` 的合作方式。

這不是把兩個專案合成同一個系統，也不是讓 Harness 變成 code review engine。

## 1. 責任邊界

兩個系統回答不同問題。

### Agent Work Harness

負責：

> 「這次 agent 工作是否可信地完成？」

它觀察：

- Work Contract
- Repository Contract
- Agent authority
- git diff evidence
- protected / denied paths
- test / lint / typecheck / build
- runtime protocol
- recovery / retry / durable execution

輸出偏向：

```
SUCCESS
FAILED
BLOCKED
POLICY_VIOLATION
NEEDS_USER_DECISION
```

### Reviewer

負責：

> 「這些已完成的變更裡，哪些仍需要人工 Review？」

它觀察：

- base/head source
- changed regions
- semantic facts
- coverage
- deterministic domain policy
- unresolved evidence / impact / invariants

輸出：

```
HUMAN_REVIEW_REQUIRED
NOT_SELECTED_FOR_HUMAN_REVIEW
```

因此：

```
Harness SUCCESS
!=
不需要人工 Review
```

也同樣：

```
Reviewer HUMAN_REVIEW_REQUIRED
!=
Harness verification FAILED
```

## 2. 正確資料流

建議流程：

```
Codex / Claude Code
        ↓
Agent Work Harness
        │
        ├─ git evidence
        ├─ path policy
        ├─ test
        ├─ lint
        ├─ typecheck
        └─ build
        ↓
Harness SUCCESS
        ↓
Reviewer
        │
        ├─ Adapter
        ├─ Semantic Facts
        ├─ Domain Interpreters
        ├─ Coverage
        ├─ Eligibility
        └─ Reducer
        ↓
Review Scope Plan
   ┌───────────────┬──────────────────────────────┐
   ▼               ▼
HUMAN REVIEW    NOT SELECTED FOR HUMAN REVIEW
   │
   ▼
Human / AI Reviewer
```

Reviewer 應接在 Harness verification 之後，而不是取代 Harness verification。

## 3. 不建議的接法

### 不要把 Reviewer 當普通 verification check

Harness Repository Contract 現在有：

```json
{
  "verification": {
    "checks": [
      {
        "id": "test",
        "kind": "test",
        "argv": ["npm", "test"],
        "required": true
      }
    ]
  }
}
```

不建議直接加：

```json
{
  "id": "reviewer",
  "kind": "custom",
  "argv": ["reviewer", "plan"],
  "required": true
}
```

原因：

Harness verification 的語意是：

```
PASS / FAIL
```

Reviewer 的語意是：

```
Review Scope
```

`HUMAN_REVIEW_REQUIRED` 不是 verification failure。

如果硬塞進 `verification.checks`，會把「程式驗證失敗」與「這個檔案仍值得人看」混成同一件事。

## 4. 建議整合契約

未來 Harness 可增加獨立 review provider contract：

```json
{
  "review": {
    "enabled": true,
    "provider": "reviewer",
    "argv": ["reviewer", "plan"]
  }
}
```

它必須與 `verification` 分離。

Harness report 可呈現：

```
Attempt Result
────────────────
SUCCESS

Verification
────────────────
test       PASS
lint       PASS
typecheck  PASS
path       PASS

Review Scope
────────────────
Changed          17
Human Review      5
Not Selected     12
Reduction       70.6%
```

Review scope 不應反向修改 Harness Outcome。

## 5. Reviewer 需要補的產品入口

目前 Reviewer 已有核心 pipeline，但還沒有正式的 multi-file `plan` CLI。

建議下一個產品入口：

```bash
reviewer plan \
  --repo /workspace/project \
  --base <base-sha> \
  --head <head-sha> \
  --format json
```

它應：

1. 取得 `base..head` changed files。
2. 對支援的 PHP files 執行 Adapter。
3. 套用 production interpreter set。
4. 聚合 file-level decision。
5. 輸出 Review Scope Plan。

預期 JSON：

```json
{
  "schemaVersion": "1",
  "repository": "example/repo",
  "baseSha": "abc123",
  "headSha": "def456",
  "reviewScope": {
    "humanReviewRequired": [
      {
        "path": "app/Services/PaymentService.php",
        "fallback": "TARGETED",
        "reasons": [
          "PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED"
        ]
      }
    ],
    "notSelected": [
      {
        "path": "app/DTO/UserDTO.php"
      }
    ]
  },
  "metrics": {
    "changedFiles": 17,
    "humanReviewFiles": 5,
    "notSelectedFiles": 12,
    "reviewScopeReduction": 0.706
  }
}
```

## 6. Harness 需要補的入口

在 Reviewer 有 `plan` CLI 後，Harness 建議增加：

```bash
harness review <workId>
```

流程：

```
workId
  ↓
latest successful Attempt
  ↓
attempt.baseRevision
  ↓
actual changed tree
  ↓
reviewer plan
  ↓
review_scope.json
  ↓
Harness Artifact Store
  ↓
Review Scope section
```

Harness 應保存：

- Reviewer command/version。
- base/head SHA。
- Reviewer analysis identity。
- raw `review_scope.json` artifact。
- Review scope summary。
- publication/event trace。

可增加事件：

```
review.scope.created
review.scope.published
```

但這些事件不改寫原本的 verification evidence。

## 7. GitHub PR 上的使用方式

Harness 的工作目錄分析適合開發完成後立即看 review scope。

真正 PR 上則應以 GitHub PR 的：

```
base SHA
head SHA
```

重新跑 Reviewer，避免依賴舊的 working-tree 結果。

建議 GitHub workflow：

```
pull_request opened / synchronize / reopened
        ↓
checkout base/head
        ↓
reviewer plan
        ↓
Review Decision Summary
        ↓
GitHub Check / PR Summary
```

範例：

```
Review Reduction / Scope

Changed files          17
Human Review Required   5
Not Selected           12
Review Scope Reduction 70.6%

HUMAN REVIEW
- app/Services/PaymentService.php
  PAYMENT_IDEMPOTENCY_IDENTITY_CHANGED
- app/Services/WalletService.php
  TRANSACTION_BOUNDARY_REMOVED

NOT SELECTED
- app/DTO/UserDTO.php
- app/ValueObjects/Money.php
...
```

人工 Reviewer 從 17 個 changed files 縮到 5 個。

## 8. Codex / Claude Code 如何使用

Codex / Claude Code 可以是 Review Scope 的 consumer，但不能成為 reduction authority。

建議：

```
Reviewer
  ↓
Review Scope Plan
  ↓
只把 HUMAN_REVIEW_REQUIRED files 提供給 AI reviewer
```

這會同時縮小：

- Human Review 範圍。
- AI Review context。
- token 使用。
- 重複看低風險 diff 的成本。

可以另外提供一個薄 skill：

```
review-scope
```

只負責呼叫：

```bash
harness review <workId>
```

或：

```bash
reviewer plan ...
```

Skill 不得自行把檔案改成 `NOT_SELECTED`。

## 9. File-level 與 Region-level

目前建議產品承諾停在：

> 縮減需要人工 Review 的「檔案集合」。

目前 semantic facts 雖然有 byte provenance，但 blocker 尚未正式建立：

```
blocker
  ↓
factId
  ↓
provenance
```

的完整、可驗證 selection contract。

因此目前不應宣稱：

```
PaymentService.php 只有 line 83-91 要看，其餘不用看
```

Region-level reduction 應在 file-level reduction 經 Historical corpus 驗證後再做。

## 10. Authority 原則

整合後仍應保持：

```
Agent / LLM
    ↓
提出變更 / 找問題 / 解釋
    ↓
Machine Facts
    ↓
Deterministic Policy
    ↓
Evidence
    ↓
Decision
```

LLM 可以協助：

- 找 hypothesis。
- 解釋 blocker。
- 對 selected scope 做 Review。

LLM 不應直接授權：

```
NOT_SELECTED_FOR_HUMAN_REVIEW
```

這個 authority 必須留在 Reviewer deterministic pipeline。

## 11. 建議實作順序

```
1. reviewer plan CLI
2. multi-file aggregation contract
3. Review Scope JSON schema
4. harness review <workId>
5. Harness artifact / trace integration
6. GitHub PR workflow
7. 真實 Historical PR corpus
8. region-level blocker → provenance binding
```

這樣 Reviewer 與 Harness 都維持單一職責，不會演化成兩套互相重疊的 coding agent / review agent。
