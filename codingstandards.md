# 審查規範

本文件供 AI reviewer 審查變更使用；環境、指令與不可破壞的不變量見 [AGENTS.md](AGENTS.md)。Reviewer 從 merge base 讀取本文件，這次 PR 新增或修改的規範不會影響這次審查。

- 安全決策需要完整證據。未知值、缺少資料、analyzer 失敗與 AI 失敗必須保留人工審查；AI 不能放行單向門，也不能改寫機械審查的 decision。
- 修改 analyzer、fact 或 interpreter 時，確認相關呼叫端、coverage、provenance 與路由仍一致；測試應包含正常案例與無法驗證時的 fail-closed 結果。
- 測試應驗證對外行為與失敗邊界，避免只重複實作、斷言內部結構，或靠放寬 fixture 預期值消除失敗。
- AI 修正只適用於明確允許的檔案；修正後必須跑目標專案的檢查，commit 後對新的 head 重新審查，不能沿用修正前的通過結果。
- Docker 機械審查保持無網路與唯讀。AI 連網、傳入憑證與目標寫入必須明確選用；Git metadata 維持唯讀，憑證不得寫入命令列參數值、報表或 image。
- 優先沿用現有介面與標準函式庫；新增程式只涵蓋這次需求，保留原有錯誤處理與信任邊界驗證。
