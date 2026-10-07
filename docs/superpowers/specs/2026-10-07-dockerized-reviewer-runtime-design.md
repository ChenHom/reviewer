# Dockerized Reviewer Runtime Design

## 目標

讓 Reviewer 的 PHP/Laravel analyzer 只存在於 Docker image；本機不安裝 PHP、Composer，也不產生 `analyzers/php/vendor/`。開發者以 npm script 建置 image、執行 PR review 與完整 release gate。

既有 deterministic core、PHP adapter contract、fail-closed reason codes 與 review decision 語意保持不變。本次只替換 runtime packaging 與操作入口，不改寫 analyzer 或新增服務。

## 採用方案

建立單一 Reviewer image，內含：

- Node.js 24；
- PHP 8.4 CLI；
- Composer 2；
- `npm ci` 產物；
- 由 `analyzers/php/composer.lock` 安裝的 PHP vendor；
- Reviewer source、CLI、tests 與 evaluation fixtures。

Image 使用官方 Node、PHP 與 Composer images 的 multi-stage build。PHP vendor 留在 image layer，不 bind mount 回本機。

不採用以下方案：

- Host Node 每分析一個檔案就啟動 PHP container：container startup 成本高，且會把 command/path translation 滲入 adapter。
- 常駐 PHP sidecar：需要 RPC protocol、health check 與服務生命週期，現階段沒有足夠需求。
- 將 PHP analyzer 重寫成 JavaScript：風險與維護成本遠高於 packaging 問題本身。

## 操作介面

新增三個明確入口：

```bash
npm run docker:build
npm run review:docker -- --base origin/master --head HEAD
npm run test:docker
```

`review:docker` 預設將目前目錄視為待 review repository。若要 review 其他 repository，使用 `REVIEW_TARGET=/absolute/path`。wrapper 將該目錄唯讀掛載到 container 的固定路徑，並把 CLI 參數原樣轉交給既有 `bin/review.js`。

`test:docker` 先建置 image，再於 image 內執行 PHP syntax lint 與既有 `npm run test:all`。`npm run test:all` 保留為 container 內部 release gate，不宣稱沒有 PHP 的 host 能直接執行它。

第一版 Docker 入口以 stdout / `--json` 輸出報告。`--out` 只有在呼叫端明確提供 `REVIEW_OUTPUT_DIR`，由 wrapper 將該目錄掛載到 `/output` 時才支援；不把待 review repository 改成可寫掛載來換取便利。

## 執行流程

```text
Host npm script
    -> docker build (cacheable)
    -> docker run --rm
       -> read-only target repository mount
       -> node bin/review.js
       -> existing PHP adapter
       -> php analyzers/php/bin/analyze.php
       -> JSON stdin/stdout
       -> existing deterministic pipeline
```

Node 與 PHP 在同一 container，因此 `createPhpLaravelAdapter()` 繼續使用目前的 `php` subprocess contract，不新增 adapter interface、HTTP endpoint 或 path translation logic。

## Container 邊界

Review runtime 必須符合：

- target repository 唯讀掛載；
- 不掛載 Docker socket；
- runtime 使用 `--network none`；
- container 執行完即刪除；
- 暫存資料只寫入 container `/tmp`；
- 不把 Composer cache、vendor 或 credentials 寫回 host；
- 不把 GitHub token 或其他 production credential baked into image。

若 host repository ownership 觸發 Git safe-directory 檢查，wrapper 只透過 container environment 對固定 target path 設定 safe directory，不修改 host 或 image 內的 Git config。

## Build 與快取

Dockerfile 先複製 lockfiles 並安裝依賴，再複製 source，使 source 變更不會反覆重裝 npm/Composer dependencies。`.dockerignore` 排除：

- `.git`；
- host `node_modules`、coverage 與 temporary evaluation output；
- host PHP vendor；
- 其他與 build 無關的本機產物。

Image 只依 `package-lock.json` 與 `analyzers/php/composer.lock` 解析依賴；build 不執行 npm `prepare`，避免在 image build 階段安裝無意義的 Git hook。

## CI

GitHub Actions 改用與本機相同的 Docker path：

```text
docker build
docker run <image> PHP syntax lint + npm run test:all
```

移除 workflow 內分開安裝 Node、PHP 與 Composer 的步驟，避免本機與 CI 維護兩套 runtime setup。CI runtime 不需要 repository write permission 或外部服務 credential。

## 錯誤處理

- Docker daemon 不可用或 image build 失敗：wrapper 直接以非零 exit code 結束，不偽裝成 analyzer decision。
- Container 內 PHP/Composer dependency 缺失：build 或 release gate 失敗。
- Review 執行期間 analyzer 失敗：沿用既有 `PHP_ANALYZER_*` fail-closed 行為。
- Target path 不存在或不是 Git repository：在啟動 container 前拒絕，回傳可讀錯誤。
- Runtime 無網路不影響 review；任何意外網路依賴會立即暴露為失敗。

## 驗收條件

1. Host 沒有 `php`、`composer` 與 PHP vendor 時，`npm run test:docker` 通過完整 release gate。
2. `npm run review:docker -- --base <ref> --head <ref>` 能 review 唯讀掛載的 Git repository。
3. Review container 在 `--network none` 下正常運作。
4. 執行後 host 不新增 PHP vendor、root-owned file 或未預期的 tracked change。
5. 既有 PHP failure codes、decisions 與 test expectations 不因 Docker packaging 改變。
6. GitHub Actions 使用相同 image 與 gate 並通過。

## 明確不做

- 不建立常駐 analyzer service。
- 不加入 Docker Compose；單一 image 與單一 process 已足夠。
- 不重寫 PHP analyzer。
- 不把 Docker transport 放進 deterministic core 或 adapter contract。
- 不自動安裝 Docker，也不管理 host Docker daemon。
- 不在第一版加入 registry publish、image signing 或多架構 release image；需要分發預建 image 時再增加。
