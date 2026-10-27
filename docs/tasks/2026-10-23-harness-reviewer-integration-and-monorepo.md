# Harness／Reviewer 審查交接與雙模組遷移開發任務

日期：2026-10-23

狀態：`PLANNED`（本文件是開發計畫；尚未實作交接入口；主 repo 已建立，但只含 submodule 綁定）

目標：先在兩個 repo 間完成可信的審查交接，再以主 repo `agent-workbench` 用 git submodule 組合兩個獨立模組。

相關文件：[現有整合契約](../integrations/agent-work-harness.md)、[Review CLI](../review-cli.md)、[二次 review 狀態](../review-state.md)、[Docker 本機審查](../review-cli.md#docker-本機審查)、[既有任務與已知偏差](2026-08-12-review-reduction-next-phase.md)。

## 一、範圍與責任

本計畫以單一操作者、單一 Host 的本機開發流程為第一個驗收環境。

| 部分 | 責任 |
|---|---|
| Harness | 保存需求、authority、Work／Attempt、驗證 evidence、重試與恢復 |
| Reviewer | 對明確的 commit 範圍做機械分類、AI 審查與人工待確認項目計算 |
| 審查交接入口 | 綁定 candidate、contract、執行版本與報表，處理錯誤／過期，不改寫兩邊既有決策 |
| 人工 | 確認需求取捨、單向門、未決事項，以及是否 push 主 repo |

保留兩個 CLI、兩套既有 gate、各自的依賴與 lockfile。Reviewer 的 PHP／Composer／vendor 保持在 Docker 內；不把 Harness 的全部執行環境塞入 Reviewer image。

以下不在本輪開發範圍：

- GitHub PR bot、留言／ack transport、Check 發布、自動開 PR／合併。
- 統一兩邊資料庫、抽共用核心、導入新的流程框架。
- npm workspaces／依賴 hoisting、跨 Host takeover、排程與新 deployment。
- 批次改寫 live Harness Work／Attempt／artifact 歷史。
- 刪除、封存、重新命名原 repo，或自動推送遷移結果。
- 以本計畫取代既有 `DEV-01`～`DEV-06` correction 工作。相關安全風險須列入接入限制，不能用本輪 gate 宣稱它們已修復。

GitHub 自動審查與「保留既有 CI」分開看待：本輪可以先完成本機交接與主 repo 組合驗證。兩個模組的 CI 與保護規則留在原 repo，不因主 repo 而改變；主 repo push 前仍須確認這些 gate 沒有失效，且 gitlink 指向的 commit 都已在原 repo 遠端。

## 二、評估依據與限制

本計畫依據 2026-10-23 的來源檢查與隔離副本驗證：

- Harness 來源 HEAD：`a156e9a8dc47558620b3cbd3dab49b36aef605f8`。
- Reviewer 來源 HEAD：`ca65a41ff06edd24afbb4f3a51826b2016f54c87`，另包含當時 `feat/docker-ai-review` 的未提交修改；不能把這些修改誤認成已在 HEAD 或遠端。
- 保留各自內部結構與依賴後，兩個模組在共用 Git root 的副本中通過各自完整 gate；這不是全新 monorepo 安裝器或審查交接功能已完成的證據。Reviewer 現行驗證基準以 [README](../../README.md#目前驗證基準) 為準；開發時必須重新量測。
- 實測 Harness 可對未提交修改得到 `SUCCESS`，同時 Reviewer 對相同 `HEAD` 回報 `NO_CHANGES`；commit 後才選出該變更。
- bwrap workspace 指向子模組時看不到外層 `.git`；使用 monorepo 根目錄則能觀察 Git。
- nested `codingstandards.md` 存在，不代表 Reviewer 能從 repo 根目錄載入它。
- 根套件只有轉呼叫 scripts 時，`detectCandidate()` 不會自動加入模組測試；根套件安裝也不會自動暴露子模組 bin 或安裝其依賴。
- 預設 Harness agent／verification 環境不含測試 API key，沙箱也沒有 Docker socket。

完整歷史報告與原始 log 當時保存在 `/tmp/harness-reviewer-evaluation-20261023/`，副本在 Reviewer 的 `.worktrees/harness-reviewer-evaluation-20261023/`。這些暫存路徑可能被清除；本計畫的驗收不得依賴它們永久存在。新的驗收須重新建立 fixture 並保存去除憑證的 log、版本與 checksum。

## 三、不可破壞的規則

1. `Harness SUCCESS` 不代表不需人工 review；`HUMAN_REVIEW_REQUIRED` 不等於測試失敗。
2. Reviewer 的機械 `decision`、三層路由與單向門語意不變。AI 不能放行 `ESCALATED`。
3. 缺報表、格式不符、analyzer error、來源不符、timeout 或 stale，均不能呈現為審查通過；exit 0 不能單獨充當成功證據。
4. candidate 使用明確 SHA，不在執行途中重新解讀可移動的 `HEAD`／branch。報表須綁定同一個 candidate、Work Contract 與 Repository Contract。
5. 使用者既有 dirty changes 不得被自動帶入結果 commit、覆寫、reset 或 stash。
6. AI 修正是新的變更，必須重新執行範圍檢查與必要驗證，commit 後對新 head 重審。
7. API key、Docker socket、Host HOME 不交給一般 repository scripts。機械審查離線；AI 的連網與費用另行明確選用。
8. 修改既有 Attempt outcome、擴大 authority、放寬 frozen contract 或提高 retry budget，都不能作為消除 pending review 的手段。
9. 搬目錄不代表可以改變 `.reviewer.json`／`codingstandards.md` 從 merge base 讀取的規則。
10. 每項實作遵守先失敗測試、最小修正、targeted tests、所屬專案完整 gate、code review、安全檢查與必要量測；每個可獨立交付 task 各自提交。

## 四、執行順序與完成邊界

```text
HR-00 現況收尾與 baseline
  → HR-01 candidate／版本交接契約
  → HR-02 報表驗證契約
  → HR-03 受信任 Reviewer runner
  → HR-04 Harness CLI／artifact／event
  → HR-05 兩 repo 機械交接 E2E
       ├→ HR-06 AI 審查與修正重驗
       └→ HR-07 主 repo 與 submodule 規則
              → HR-08 主 repo 與 gitlink 綁定
              → HR-09 安裝／沙箱／Docker 相容性
              → HR-10 本機驗收與主 repo 發布檢查
```

- 第一階段以 HR-00～HR-05 為交付：兩 repo 間可用的機械審查交接，不需要 GitHub 整合，也不需要 API 憑證。
- HR-06 是 AI 流程的獨立驗收；缺少真實 API 驗證時，必須保留為未完成，不影響機械階段的完成判定。
- 第二階段以 HR-07～HR-10 的本機部分為交付：主 repo 以 submodule 組合兩個模組的本機流程。沒有 HR-06 證據時，不能宣稱 AI 流程也完成。
- 主 repo push、舊本地 clone 退役、舊 repo 封存與 live state 路徑調整，均不由本文件的 checkbox 自動授權。

## 五、開發任務

### HR-00 — 現況收尾與可重現 baseline

狀態：四項皆已勾選（2026-10-27）。驗收有經使用者授權的偏離：Harness `a85089f` 已 push；Reviewer 的修改其後經 PR #15 合入 `master`（`e04cfd0`）。見 [HR-00 紀錄](2026-10-27-hr-00-baseline.md)第十節。依賴：無。工作位置：Reviewer 與 Harness 各自的獨立功能分支。

- [x] 盤點兩邊 HEAD、分支、未提交修改、lockfile、安裝入口與資料保存位置，記錄本次起點。紀錄：[HR-00 起點紀錄](2026-10-27-hr-00-baseline.md)（2026-10-27）。
- [x] 將目前 Docker AI 入口修改獨立 review、驗證與提交；原有 next-phase 任務紀錄修改另外保留，不混入 feature commit。機械面完成（2026-10-27）：
  - 本地 commit `4ce8e99`、`63a196d`、`0e5a64a`、`6d9e6a6`，各自在隔離副本通過 Docker gate。
  - 四輪獨立審查找到的中等 finding 都已修好並經複審確認，最後一輪中等以上 finding 為 0。
  - 其後經 [PR #15](https://github.com/ChenHom/reviewer/pull/15) 以 merge commit `e04cfd0` 合入 `master`；低風險項目列為後續。

  見 [HR-00 紀錄](2026-10-27-hr-00-baseline.md)第八節。
- [x] 檢查既有已知偏差哪些會影響接入安全；列出限制與所屬修正任務，不把「gate 全過」當成偏差已關閉。完成（2026-10-27）：在 `review` CLI 路徑上的只有 DEV-01；DEV-02～DEV-06 目前不可達；Harness D-08、D-23、D-35 影響憑證位置與 candidate 範圍。8 條接入限制見 [HR-00 紀錄](2026-10-27-hr-00-baseline.md)第九節。
- [x] 在隔離副本重新執行 Harness `npm run check` 與 Reviewer `npm run test:docker`，保存 gate 結果與版本。不要在 Host 安裝 PHP／Composer／vendor。完成（2026-10-27）：
  - Harness baseline `a85089f`：416 pass。
  - Reviewer baseline `6d9e6a6`：Docker gate 453 pass；已隨 PR #15 合入 `master`（`e04cfd0`）。
  - PHP 依賴只裝在 image 內。重建方式與限制見 [HR-00 紀錄](2026-10-27-hr-00-baseline.md)第十節。

驗收：可從具體版本重建 baseline；現有使用者修改完整保留；沒有混入正式搬移、push 或實際 API 請求。

### HR-01 — candidate 與驗證版本交接

狀態：`PLANNED`。依賴：HR-00。主要位置：Harness `src/orchestrator.ts`、`src/evidence/git.ts`、`src/evidence/verification.ts` 與新的審查協調程式。

建議入口為 `harness review <workId> --head <candidate-sha>`；完整 argv、exit code 與錯誤代碼在此 task 定稿並同步文件。第一版不自動 commit，也不自動挑選「最新一筆看起來成功」的歷史結果。

- [ ] 決定可接受的 Attempt、Work／Repository Contract 版本與 candidate 來源；不同 milestone／branch 不得混用。
- [ ] 要求 repository workspace 是 Git root，並一次解析／凍結 base、candidate SHA、merge base 與 repository identity。
- [ ] 定義 candidate 與該 Attempt 的關聯驗證；僅「是 base 的後代」不足以證明它就是本次結果。
- [ ] 在指定 candidate 的乾淨工作副本上，以原本 frozen contract 重跑必要驗證與 path policy；不沿用 dirty worktree 的舊成功 evidence。
- [ ] 驗證前後檢查 candidate／contract／workspace 漂移；不符合時保留明確失敗或 stale，不輸出可用審查結果。
- [ ] 定義既有 pre-existing dirty changes 與未追蹤檔案的處理：第一版不自動打包它們；需要納入者必須先成為明確 candidate。

驗收測試：未 commit 的有效修改不能被當成已完成審查；無關 commit、錯 repo、錯 Attempt、非預期 merge base、untracked／mode／symlink 變更、驗證期間修改與 contract 版本變更均有反例。合法 candidate 則能得到與它綁定的新 evidence。

### HR-02 — 有版本的報表驗證與交接 envelope

狀態：`PLANNED`。依賴：HR-01。主要位置：Harness 新增審查報表 contract；Reviewer 現有 JSON 報表為輸入。

- [ ] 定義交接 envelope 的 `schemaVersion`、work／attempt identity、frozen contract hash、base／head／merge base、Reviewer 版本與 immutable image identity、raw report hash。
- [ ] 明確區分「有可用報表」與「沒有人工待辦」；狀態不得只剩一個模糊的 pass boolean。
- [ ] 對 Reviewer JSON 做必要結構與一致性檢查，包含已知 decision／track、檔案總數、重複 path、範圍 identity、analyzer failure 與 pending fixes。缺少必要欄位不可使用預設安全值補齊。
- [ ] 定義 report contract 相容版本與 runner 版本的關聯；不能把目前沒有 schemaVersion 的任意 JSON 一律當成相容。優先在邊界封裝，若確需改公共 JSON，須同步所有 consumer 與文件。
- [ ] 顯示用 repository basename 不作權威 identity；政策與規範摘要的來源須可核對，不能信任任意外部輸入。

驗收測試：成功報表、NO_CHANGES、需要人工、未知 enum、欄位缺失、空物件、數量矛盾、錯 SHA／contract、不同目錄同 basename、analyzer error 與 malformed JSON 都有明確預期；驗證器拒絕結果不得被上層改成通過。

### HR-03 — 受信任且有邊界的 Reviewer runner

狀態：`PLANNED`。依賴：HR-01、HR-02。主要位置：Harness 既有執行邊界與 Reviewer Docker 入口。

- [ ] 固定允許的 Reviewer 執行方式、image identity、參數組裝與報表位置；使用 argv／shell=false，不接受模型提供的 shell 字串。
- [ ] 機械審查在無網路、非 root、唯讀 root filesystem／candidate／Git metadata 的容器中執行，只有指定輸出與 tmpfs 可寫。
- [ ] 由受信任流程啟動 Docker，不把 Docker socket、API key 或額外 Host bind 放進一般 verification／agent 沙箱。
- [ ] 遵守 Harness 對 `child_process` 的架構限制；若新增 trusted execution 能力，範圍必須可由 lint 與測試限定，不直接解禁整個模組。
- [ ] 定義 deadline、取消、子行程回收、輸出上限、非零 exit、容器失敗、報表缺失／過大與 late result 的處理。
- [ ] 在接納結果前重新核對 candidate 與 contract；晚到的舊 run 不得覆蓋新結果。

驗收測試：fake runner 控制 timeout／取消／晚到／錯誤 receipt；另以真實 Docker 驗證普通 repo 與 linked worktree、權限、輸出 ownership、`.git` 與重疊輸出掛載保護。所有錯誤都不能成為可用審查證據。

### HR-04 — Harness CLI、artifact 與 trace 整合

狀態：`PLANNED`。依賴：HR-03。主要位置：Harness `src/cli.ts`、`src/trace/store.ts`、`src/cli-format.ts` 與審查協調程式。

- [ ] 實作 HR-01 定稿的 review 指令；會保存結果的操作取得 execution ownership，純查詢保持 read-only。
- [ ] 使用現有 content-addressed artifact store 保存 raw report 與 envelope；trace 事件引用 artifact，不先建立第二套 store 或共用資料庫。
- [ ] 每次使用保存報表時驗證 hash／存在性與 identity；刪除、損壞或過期 artifact 不得沿用成功畫面。
- [ ] 並列呈現工作驗證結果、審查執行結果、人工待辦與未提交修正；HUMAN_REVIEW_REQUIRED 不自動增加 coding retry。
- [ ] 不改寫原 Attempt outcome、Work Contract 或 retry budget；若需要狀態變更，另有明確 authority 與事件。
- [ ] CLI argv、exit code、錯誤代碼、查詢方式與目前限制同步至 Harness 使用文件與 Reviewer 整合文件。

驗收：一次合法呼叫能留下可核對的 artifact／trace；重複執行、重啟、並行執行、ownership 衝突、損壞報表與 stale 都不會造成錯誤通過或改寫舊 Attempt outcome。若確需 DB schema 變更，依 Harness migration 規則另補驗證。

### HR-05 — 兩 repo 間的機械交接 acceptance

狀態：`PLANNED`。依賴：HR-04。

- [ ] 建立獨立 fixture repo，以 fake runtime 產出修改，但使用真實 Git、path policy、verification 與 Docker Reviewer 走完整交接；不呼叫真實 Codex 或 AI。
- [ ] 覆蓋合法 commit、dirty result、未追蹤檔、單向門、一般人工項目、無變更、analyzer failure、runner timeout 與 malformed report。
- [ ] 在驗證前後、Review 執行中、保存前切換 candidate／contract，確認舊結果不會變成新 head 的有效證據。
- [ ] 覆蓋既有使用者 dirty changes、不屬於當次 Work 的修改、錯 repo 與相同 basename。
- [ ] 確認一般 verification 與 agent 看不到 AI 憑證／Docker socket；確認人工待辦不觸發自動 coding retry。
- [ ] 跑兩邊完整 gate、獨立 code review、安全 review 與量測；保存執行時間、image identity、輸出規模與不含憑證的證據。

第一階段完成條件：兩 repo 交接入口真實可用，上述 acceptance 全過，文件與程式一致；不能只憑先前的評估探針或 unit tests 標記完成。

### HR-06 — AI 審查、受控修正與真實 API 驗證

狀態：`PLANNED`。依賴：HR-05；真實 API 部分另需可用憑證與明確的付費執行範圍。

- [ ] 先接唯讀 AI review，網路與憑證只給 Reviewer；機械審查的離線入口保持不變。
- [ ] 將 AI 執行版本、檔案數／並行限制、deadline、usage、fallback 與失敗列入結果；沒有 usage 不能宣稱費用為零，也不能宣稱已具備 Harness 端到端費用硬上限。
- [ ] AI apply 只在指定 candidate worktree 執行，變更範圍不得超過已確認 Work Contract。無法可靠限制修正範圍時，第一版只提供建議，不啟用自動 apply。
- [ ] 修正後重新跑必要驗證與 path policy；經確認 commit 成為新 candidate，再從機械審查開始。原人工確認與舊報表不得自動轉用。
- [ ] 第一版最多自動執行一輪修正；再有疑慮或失敗交給人，不建無限修正／重試迴圈。
- [ ] 以 fake client 覆蓋 PASS、FIX、NEEDS_HUMAN、拒絕、錯格式、timeout、取消與套用修正命中單向門。
- [ ] 有憑證後，以小型非敏感 fixture 做真實 API smoke test，確認確有送審、schema 合法、實際模型與 usage 可讀；不能用全 AUTO_PASS 或單看 exit 0 宣稱成功。

驗收：AI 不能放行單向門、越過 Work authority、沿用舊 candidate 或繞過驗證。fake 測試與真實 API 證據分開記錄；缺少真實 API 證據時，此 task 不得標記完整完成。

### HR-07 — 主 repo 與 submodule 規則

狀態：`PLANNED`。依賴：HR-05（結構決策與本機主 repo 已依使用者決定於 2026-10-27 先行建立）。

已決（2026-10-27，使用者確認）：新專案名稱 `agent-workbench`，本機根路徑 `/home/hom/services/agent-workbench`；以 **git submodule** 組合，不匯入歷史：`modules/harness` → `git@github.com:ChenHom/agent-work-harness.git`，`modules/reviewer` → `git@github.com:ChenHom/reviewer.git`。兩個原 repo 繼續是各自的來源、歷史、CI 與 branch protection 所在；原本地 clone（`/home/hom/code/harness`、`/home/hom/code/reviewer`）不搬移。

已建立（2026-10-27）：本機主 repo 初始 commit `74b6f46`，gitlink 指向 harness `a156e9a8`、reviewer `ca65a41f`（兩者 `master`）。

遠端（2026-10-27，依使用者指示）：

- 建立 private repo `ChenHom/agent-workbench`，預設分支 `master`，並把本機主 repo 的 `origin` 設為 `git@github.com:ChenHom/agent-workbench.git`。兩個 submodule 的原 repo 仍是 public。
- `26f326e`（`Use relative submodule URLs and move harness to a85089f`）做了兩件事：
  - `.gitmodules` 改成 `../agent-work-harness.git`、`../reviewer.git`。先設好 `origin` 才執行 `git submodule sync`，同步後解析出的 URL 仍是原本兩個 SSH 遠端。
  - harness gitlink 從 `a156e9a8` 以 fast-forward 更新到 `a85089f`。
- gitlink 的依據：
  - harness `a85089f`：在 `origin/master`，有 HR-00 的完整 gate 證據（416 pass，GitHub Actions `check` success）。
  - reviewer：`26f326e` 時維持 `ca65a41`（當時的 `origin/master`），因為 HR-00 baseline `6d9e6a6` 尚未 push。PR #15 合併後，`50abe4f`（`Move reviewer to e04cfd0`）以 fast-forward 更新到 `e04cfd0`。依據：`e04cfd0` 的檔案樹與 `d4380b3` 相同，`d4380b3` 的 push 與 pull_request 兩次 `safety` 都是 success，`e04cfd0` 自己在 `master` 上的 CI（run `40503028488`）也是 success。
- push 前確認兩個 gitlink 的 commit 都在各自的 `origin/master`，再 `git push -u origin master`；第一次 push 後遠端 `master` 為 `26f326e`。第二次 push（`50abe4f`）前做了同樣的確認，之後遠端 `master` 為 `50abe4f`。
- 驗證：`50abe4f` 也以全新 clone 確認，submodule 為 harness `a85089f`、reviewer `e04cfd0`。第一次的驗證如下：從 GitHub 執行 `git clone --recurse-submodules` 全新 clone，主 repo HEAD 為 `26f326e`；submodule 為 harness `a85089f`、reviewer `ca65a41`，兩者的 `origin` 都解析為原本的 SSH 遠端。只驗證了 SSH clone；HTTPS clone 未測。

submodule 對本計畫的影響（2026-10-27 實測，HR-07～HR-10 已據此改寫）：

- 主 repo 只記錄 gitlink（mode `160000`），看不到模組內檔案變更。Reviewer 與 Harness Work 須以子模組為 workspace／Git root；對主 repo 範圍審查只會看到指標變動，不能當成模組審查。
- 子模組的 `.git` 是指向 `../../.git/modules/modules/<name>` 的 gitfile。bwrap 只掛子模組目錄時 `git` 失敗（`not a git repository`）；掛主 repo 根目錄則可讀到 HEAD。
- Reviewer 工作樹版本的 `bin/review-docker.sh`（`feat/docker-ai-review`，尚未進 `master`）以 `--absolute-git-dir`／`--git-common-dir` 解析並設定 `GIT_DIR`，設計上可處理 gitfile；未實跑驗證。
- `.reviewer.json`／`codingstandards.md` 仍由各模組 repo 自己的 merge base 讀取；主 repo 根層的政策檔不會套用到模組審查。
- 跨兩個模組的變更須在兩個 repo 各自提交，再更新主 repo gitlink；沒有原子提交。
- 安裝沿用各模組原本方式（例如 `npm i -g github:ChenHom/reviewer` 不受影響）；不需要決定歷史匯入方式。

仍待決：主 repo 是否需要根層指令、CI 或 branch protection；日常開發是否改到 submodule checkout（原本地 clone 是否退役）。

- [ ] 定義 gitlink 更新規則：只指向已 push 到原 repo 遠端、且通過該模組完整 gate 的 commit；每次更新記錄新舊 SHA 與對應的模組 gate 證據。
- [ ] 定義跨模組變更的順序：各模組先在原 repo 提交並通過 gate，再以一個主 repo commit 一起更新兩個 gitlink；任一模組未通過時不更新主 repo。
- [ ] 每個要由 Harness 操作的模組，在模組 repo 內維護自己的 `.harness/config.json`（`repositoryId`、`filesystem`、`verification` 等）；Reviewer 目前沒有此檔。候選設定須人工確認，不直接接受只有 diff-check 的結果。
- [ ] 確認 required checks 在 submodule checkout 與既有隔離下真的能執行。需要 Docker 或 Temporal 測試環境的 gate，不得透過開放 repository scripts 的 socket／Host 權限來勉強通過。
- [ ] 政策維持在各模組的 `.reviewer.json`／`codingstandards.md`，保留 merge-base 與只能增加攔截的語意；主 repo 不放會被誤認為能覆蓋模組的政策檔。以 fixture 確認對主 repo 範圍（只有 gitlink 變更）的審查不會被呈現為模組審查通過。
- [ ] 決定主 repo 根層內容的第一版：至少 `.gitmodules` 與說明 clone／初始化／gitlink 更新流程的 README；根層指令或 CI 只在確有需要時加入。
- [x] 主 repo 推上 GitHub 前，把 `.gitmodules` 改為相對 URL（例如 `../reviewer.git`），讓 SSH 與 HTTPS clone 都能取得 submodule。完成（2026-10-27）：`26f326e`；已以 SSH 全新 clone 驗證，HTTPS 未測。

驗收：gitlink 與跨模組規則、模組 `.harness/config.json` 與政策來源經 fixture 驗證，不會因 submodule 結構減少驗收。未決選項逐一記錄；之後每次 push 主 repo 前，都要確認每個 gitlink 指向的 commit 已在原 repo 遠端。

### HR-08 — 主 repo 與 gitlink 綁定，保留原 clone

狀態：`PLANNED`（主 repo 與兩個 submodule 已建立，其餘未做）。依賴：HR-07。工作位置：`/home/hom/services/agent-workbench`。

- [x] 建立本機主 repo，加入 `modules/harness`、`modules/reviewer` 兩個 submodule。證據（2026-10-27）：初始 commit `74b6f46`；`git submodule status` 為 harness `a156e9a8`、reviewer `ca65a41f`。
- [x] 依 HR-07 規則把 gitlink 更新到要驗收的模組 commit。原本地 clone 尚未 push 的 commit（例如 2026-10-27 時 Harness 本地 `master` 的 `a85089f`）須先在原 repo push，不從本地 clone 直接接入。完成（2026-10-27）：
  - harness `a85089f`（`26f326e`）、reviewer `e04cfd0`（`50abe4f`），兩者都在原 repo 的 `origin/master`，各自的 GitHub Actions CI 都是 success；gate 依據見 HR-07。
  - 以全新 clone 驗證過。
  - 模組之後再前進時，要依同樣規則重新更新。
- [ ] 主 repo 只提交 `.gitmodules`、gitlink 與根層說明；模組內容一律回原 repo 提交。不在主 repo 放 live state、憑證、node_modules 或 PHP vendor。
- [ ] Reviewer Docker build context 保持 `modules/reviewer`，不把 Harness／Temporal 依賴混入 image。
- [ ] 驗證 submodule checkout 內的 Git root、candidate SHA、merge base、歷史 baseline ref 與 artifact identity，與原本地 clone 對同一 SHA 的結果一致。
- [ ] 盤點指向原本地路徑的設定、自用 Work 與 Harness linked worktree（2026-10-27 時 `~/.local/share/agent-work-harness` 有 22 個檔案含 `/home/hom/code/harness`，含 `/home/hom/code/reviewer` 的為 0；Harness 有 4 個 linked worktree）。先輸出清單，不批次改寫已保存的歷史 contract／evidence。

驗收：每個 gitlink 都能對應到原 repo 遠端上的 commit；兩模組在 submodule checkout 通過各自完整 gate；原 repo、原本地 clone、worktree 與 live state 均保留。無法對應來源時，不更新 gitlink。

### HR-09 — 安裝、CLI 與沙箱／Docker 的 submodule 相容性

狀態：`PLANNED`。依賴：HR-08。

- [ ] 驗證 clone 流程：`git clone --recurse-submodules`（或 clone 後 `git submodule update --init`）能取得兩個模組；只 clone 主 repo、未初始化 submodule 時，工具須明確報錯，不把空目錄當成模組。
- [ ] Harness 沙箱以子模組為 workspace 時，唯讀掛入該模組在主 repo 內的 Git metadata（`.git/modules/modules/<name>`），範圍不擴大到整個主 repo `.git` 或另一個模組；以 bwrap 實測 git 可讀、寫入被拒。
- [ ] Reviewer Docker 以 submodule 為目標實跑：Git metadata 唯讀、非 root UID、輸出 ownership、輸出目錄與 metadata 重疊保護、linked worktree，以及 AI 明確連網／apply 權限。
- [ ] 若主 repo 提供根層指令，必須明確切換 module cwd，避免從 root 遞迴跑錯 lint／tests；各模組 lockfile 維持自己的責任。
- [ ] 各模組沿用原本安裝方式，以專用安裝 prefix 驗證仍可用，不覆蓋操作者全域安裝；不得要求 Host PHP／Composer，或以新增 prepare script 破壞既有 git 安裝相容性。
- [ ] 主 repo README 與模組文件描述「一個主 repo、兩個 submodule」的實際行為；舊歷史文件不為了現況而改寫。

驗收：所承諾的 clone、安裝與 CLI 路徑全部有可執行證據；沙箱與 Docker 在 submodule 結構下的 Git 存取經實測，未實測的項目明列未驗證。

### HR-10 — 本機總驗收與主 repo 發布檢查

狀態：`PLANNED`。依賴：HR-09；AI 完成宣告另需 HR-06。

- [ ] 從主 repo 乾淨 clone 並初始化 submodule，在 submodule checkout 跑 Harness 完整 `check` 與 Reviewer 完整 Docker gate；比較 baseline 的 pass／fail／skip，調查任何少跑或改變。
- [ ] 以 submodule 結構重跑 HR-05 交接 E2E，確認 stale、錯 identity、未知報表、人工待辦與修正後重驗沒有因 gitfile／Git metadata 位置改變而失效。
- [ ] 執行獨立 code review、安全 review、量測與 Markdown link／diff 檢查，記錄修正與尚存限制。
- [ ] 保存主 repo commit 與 gitlink 對照、安裝紀錄、artifact hash、image identity、測試 log 與不含憑證的驗收說明；沒有執行的項目明確列為未驗證。
- [ ] 確認兩個原 repo 的 CI、CODEOWNERS、branch protection 與 required check 名稱未因主 repo 而改變。GitHub 自動審查繼續延後，不在此 task 偷渡新增 transport 或 bot。
- [ ] 主 repo push 前確認：遠端名稱與可見性已定、`.gitmodules` 已改為相對 URL、每個 gitlink 指向的 commit 都已在原 repo 遠端；未確認前不 push。

本機完成條件：主 repo 可 clone 並初始化 submodule，兩模組可安裝、可獨立執行且交接完整；主 repo 發布完成條件：另有 push 後從 GitHub 全新 clone 並初始化 submodule 的證據。舊 repo 封存／刪除與原本地 clone 退役不屬於任一完成條件。

## 六、最小變更地圖

| 階段 | 預期影響範圍 |
|---|---|
| 交接契約 | Harness 審查 contract／coordinator、新測試；Reviewer 公共 JSON 僅在確有必要時變更 |
| trusted runner | Harness 既有執行邊界、Review Docker 呼叫；不放寬一般 verification sandbox |
| CLI／保存 | Harness `src/cli.ts`、`src/cli-format.ts`、`src/trace/store.ts` 的既有 artifact／event seam 與文件 |
| AI | Reviewer 既有 `src/ai/`／Docker 入口及 Harness 外層 authority／修正重驗流程 |
| 主 repo | `.gitmodules`、gitlink 與根層說明；模組內容只在原 repo 提交，保持測試、依賴、runtime 邊界 |
| 安裝／沙箱 | clone 與 submodule 初始化、Harness 沙箱與 Reviewer Docker 的 Git metadata 掛載、安裝 smoke tests |

實作前仍須搜尋每個受影響函式的所有 caller、tests、fixtures、config 與 exports；本表不是允許順手重構相鄰模組的清單。

## 七、工作紀錄格式

每項 task 的實作紀錄至少包含：

- 狀態與實際 commit；尚未 push／merge／遠端驗證時分別註明。
- 紅燈測試、最小修正、轉綠結果與完整 gate 的具體版本。
- code review／安全檢查結果、量測與尚存限制。
- artifact／image identity 與去除憑證的 log／checksum；不要把 API key 或來源程式的敏感報表寫入公開紀錄。
- 尚未驗證、待使用者決策與延後項目；不得用預算、時間或「測試大多通過」當成完成理由。

checkbox 只在有當次可執行證據時勾選。這份 task 文件的完成，不代表其中任何實作項目完成。
