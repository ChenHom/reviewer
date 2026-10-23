# PR-D — Historical PR Evaluation

Status: `IMPLEMENTED`

> 歷史紀錄：本文記錄 PR-D 合入 `master` 時（2026-10-06）的設計，之後不再更新。目前的 evaluator 與 CI pilot 數字見 [README「目前驗證基準」](../../README.md#目前驗證基準) 與 [Current State](../current-state.md)；對真實 PR 逐檔做 review scope 決策的 CLI 見 [PR Review CLI](../review-cli.md)。

Base: PR-C `feat/mutation-evaluation`

## Goal

建立 offline Historical PR snapshot evaluator，用真實或預先擷取的 PR base/head source 與人工 Review concern ground truth，量測 Review Decision Engine 是否在減少人工 Review scope 時仍覆蓋人類實際關注點。

## Scope

- Snapshot manifest 包含：
  - repository / base SHA / head SHA
  - changed PHP files 的 before/after snapshot
  - human concern id/path
- 每個 changed file 都走 production：
  `PHP Adapter → domain interpreters → coverage → reducer`。
- `humanConcerns` 絕不傳進 Adapter / interpreter；只在 decision 完成後比較，避免答案洩漏。
- 指標：
  - Human Concern Recall
  - Review Scope Reduction
  - Analysis Failure Rate
  - Full Review Rate
- human concern 落在 `NOT_SELECTED_FOR_HUMAN_REVIEW` 檔案時 evaluation gate fail。
- 支援 `sourceType=historical` 與受控 `sourceType=fixture`。

## CI Pilot

CI 內含一個明確標示為 `fixture` 的受控 pilot，只驗證 evaluator wiring，不宣稱是真實世界 historical benchmark。

真正 historical corpus 應以 offline snapshot 加入 `evaluation/historical/cases/`，避免 CI 依賴 live GitHub API/token。

## Limitation

目前 selection 粒度是 file-level；尚未做跨檔 joint impact aggregation。Historical PR 的 review comment 文字也不餵給模型，只保留 concern location/category 作為事後 ground truth。

## Gate

```bash
npm run eval:historical
```

已納入 `npm run test:all`。
