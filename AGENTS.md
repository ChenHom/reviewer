# AGENTS.md

給在這個 repo 工作的 coding agent。文件一律使用正體中文。概觀見 [README](README.md)，功能總覽見 [docs/features.md](docs/features.md)；本檔只放工作守則，細節以連結取代。

Reviewer 是 deterministic、fail-closed 的 Review Decision Engine（Node ESM）：逐檔決定哪些變更可以不選入人工 Review。

## 不可破壞的不變量

- fail-closed：unknown、不完整、analyzer 失敗都不能被解讀成安全，沒有完整證據就是 `HUMAN_REVIEW_REQUIRED`。`src/routing.js` 對不認得的 `decision` 或 `track` 一律當成 `ESCALATED`。
- 三層審查是串接的：機械審查 → AI（`--ai`）→ 人工。AI 層（`src/ai/review.js`）不能放行 `ESCALATED`（`needsHuman()` 一律為 true），AI 失敗也交給人工；AI 與路由都不改變 `decision`（`reviewRange()` 的 `decision` 在 AI 審查前就由機械審查決定）。
- `.reviewer.json` 只能新增攔截，沒有「忽略某個 fact」或「移除預設單向門」的語法。

## 環境與安裝

- Node.js：CI 用 24；開發（lint）需要 `^22.13.0 || >=24`（`eslint-plugin-jsdoc` 的 engines，比 ESLint 本身的 `^20.19.0` 更嚴）。CLI 執行期的需求見 [docs/review-cli.md](docs/review-cli.md#前置需求)。
- PHP CLI ≥ 8.3（`analyzers/php/composer.json`；CI 用 8.4）、Composer 2、`git`；release gate 另需 `tar`，且 repo 必須是有 commit 的 git checkout。
- 先 `npm ci`，再 `npm run analyzer:install`：它依序執行 `composer install --working-dir=analyzers/php`（PHP analyzer）與 `npm ci --prefix analyzers/ts`（TS analyzer）。`npm ci` 會經 `prepare` 安裝 pre-commit hook（內容是 `npm run lint`）。
- `ANTHROPIC_API_KEY` 只有 `--ai`（`bin/review.js`、`bin/retro.js`）需要；測試用假的 client，不需要它。

## 指令（package.json scripts）

- `npm run lint`：ESLint，範圍 `bin src tests evaluation analyzers/ts/bin analyzers/ts/src`（`docs/`、`fixtures/` 不檢查）。
- `npm test`、`npm run test:safety`：都是 `node --test`。`npm run test:e2e`：`tests/e2e/*.test.js`。
- `npm run test:coverage`：c8 包住 `test:safety`，門檻 lines / statements 90、functions 90、branches 85。
- `npm run eval:mutations`、`npm run eval:historical`：兩個 evaluation harness，各有 gate。
- `npm run test:all` 是 release gate：lint → test:safety → test:e2e → test:coverage → eval:mutations → eval:historical。
- `npm run eval:real-repo -- ...` 需要外部 PHP 專案，**不在** `test:all` 與 CI 內（[說明](evaluation/real-repo/README.md)）。
- `prepare` 由 `npm ci` 觸發，不必手動執行。
- CI（[workflow](.github/workflows/review-reduction-safety.yml)）在 `test:all` 之外另跑 `composer install`、`npm ci --prefix analyzers/ts` 與 `php -l`（`find analyzers/php/bin analyzers/php/src evaluation -name '*.php' -print0 | xargs -0 -n1 php -l`）；改 PHP 檔時本機要自己跑 `php -l`。
- 沒有 `php` 時 PHP analyzer 不會執行（檔案會是 `FULL` + `ANALYZER_ERROR`），無法驗證 PHP 相關結果，不要宣稱 gate 已通過。

## 程式慣例

- `eslint.config.js` 對 `src/**` 與 `analyzers/ts/**` 強制 JSDoc：每個 function declaration 都要有 JSDoc 與描述，寫了 `@param` / `@returns` 就要有描述。`tests/`、`bin/`、`evaluation/` 不強制。
- JSDoc、行內註解與測試名稱（`test('…')`）用正體中文；識別字、原因代碼與 fact 種類用英文（如 `FACT_UNHANDLED`）。既有 commit 訊息是英文。
- review CLI 只用 Node 內建模組與 `src/`；唯一的 runtime 依賴 `@anthropic-ai/sdk` 只在 `--ai` 時動態載入（`src/ai/client.js`）。

## 不要隨意改動

- `package-lock.json`、`analyzers/php/composer.lock`、`analyzers/ts/package-lock.json`：鎖定 analyzer 依賴（nikic/php-parser、typescript）與 `@anthropic-ai/sdk` 的版本，升級後必須跑 `npm run test:all`。
- `evaluation/mutations/cases.json` 與 `fixtures/`：mutation 與 historical 的基準。改既有 case 的 `expectedCurrentDecision` / `expectedTrack` 前先確認不是在放寬安全；新增 case 是正常做法（retro 的 mutation 草案就是搬進這裡）。
- README「歷史設計、計畫與任務紀錄」列出的文件（例如 `docs/tasks/2026-10-06-*.md`）：合入當時的紀錄，不為了跟上現況而改寫。
- `coverage/`、`analyzers/php/vendor/`、`node_modules/`、`real-repo-eval-output/`：產生物，已在 `.gitignore`。
- `.reviewer.json` 與 `codingstandards.md`（`POLICY_FILES`，`src/config/project-config.js`）對被審查的專案是單向門：PR 修改它們一律 `POLICY_FILE_CHANGED`，而且兩者從 merge base 讀取，不從 head 讀取。不要改變這個讀取來源或單向門語意。

## 單一來源與文件同步

- CLI 選項、exit code、原因代碼 → [docs/review-cli.md](docs/review-cli.md)；其他文件只摘要並連過去。
- 預設單向門 → `src/routing.js` 的 `DEFAULT_ONE_WAY_DOORS`；docs/review-cli.md「路由」有完整清單，[docs/project-config.md](docs/project-config.md)「單向門」列出規則產生的代碼。
- 驗證數字 → README「目前驗證基準」；其他文件連過去，不複製數字。
- 沒有測試檢查文件與程式是否一致，要手動同步：旗標變更 → `bin/*.js` 的 `USAGE` 與 docs/review-cli.md（retro 為 [docs/retro.md](docs/retro.md)）；新增原因代碼 → docs/review-cli.md「原因代碼」，要顯示說明時加到 `src/review/reasons.js`；`.reviewer.json` schema → docs/project-config.md；新增 fact 或 interpreter → README「已實作」；功能面的變化 → docs/features.md。

## 目前未實作

- 三層架構設計 §8 的步驟 7（GitHub 整合）：CLI 只讀 git 物件，輸出到 stdout 與 `--out`，不留言、不建立 check；`src/integrations/github/` 只有 port 與 payload 驗證，沒有真實 transport。見[實作紀錄](docs/superpowers/notes/2026-10-19-three-tier-implementation-notes.md)。
- AI 層（`--ai`、`--ai-apply`）與 retro 的 AI 建議只以假的 client 測試，實作時沒有 API 憑證，未對真實 API 做過 smoke test（之後是否有人驗證過：未查證）。不要在文件中寫成已驗證。
