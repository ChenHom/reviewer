# Dockerized Reviewer Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓本機只需 Node/npm 與 Docker，即可在不安裝 PHP、Composer 或 host PHP vendor 的情況下執行 Reviewer、PHP analyzer 與完整 release gate。

**Architecture:** 使用單一 multi-stage Docker image 組合 Node 24、PHP 8.4、Composer 2、npm dependencies 與鎖定的 PHP vendor。Host npm scripts 只負責建置 image、啟動離線且唯讀掛載 target repository 的 review container，以及在 container 內執行既有完整 gate；不修改 deterministic core 或 PHP adapter contract。

**Tech Stack:** Docker、POSIX shell、Node.js 24、PHP 8.4 CLI、Composer 2、npm scripts、GitHub Actions

---

## File map

- Create `Dockerfile`: 建置包含 Node、PHP、Composer、source 與兩套鎖定依賴的單一 runtime/test image。
- Create `.dockerignore`: 阻止 host dependencies、Git metadata、coverage 與 evaluation output 進入 build context。
- Create `bin/test-docker.sh`: image 內唯一的 PHP syntax lint + `npm run test:all` gate。
- Create `bin/review-docker.sh`: 驗證 host target/output path，並以唯讀、無網路 container 執行既有 CLI。
- Modify `package.json`: 提供 `docker:build`、`test:docker`、`review:docker`；移除要求 host Composer 的 `analyzer:install`。
- Modify `.github/workflows/review-reduction-safety.yml`: 使用相同 image 與 `bin/test-docker.sh`，移除重複的 host runtime setup。
- Modify `README.md`: Docker-first quick start、review target/output 與 release gate。
- Modify `evaluation/real-repo/README.md`: 移除 host `analyzer:install` 指令，明確標示 real-repo evaluation 必須在已建置 image 內執行。
- Modify `docs/safety-mvp-architecture.md`: 將標準 release gate 更新為 Docker gate。
- Modify `docs/operations/safety-mvp-next-phase.md`: 將本機/CI 操作入口更新為 Docker gate。

### Task 1: Build one reproducible image and run the full gate inside it

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `bin/test-docker.sh`
- Modify: `package.json:4-16`

- [ ] **Step 1: Record the failing host-independent gate**

Run:

```bash
test ! -e analyzers/php/vendor/autoload.php
npm run test:docker
```

Expected: the first command passes and npm fails with `Missing script: "test:docker"`.

- [ ] **Step 2: Add the minimal build context exclusions**

Create `.dockerignore`:

```dockerignore
.git
node_modules
coverage
.nyc_output
analyzers/php/vendor
real-repo-eval-output
npm-debug.log*
.DS_Store
```

- [ ] **Step 3: Add the single multi-stage image**

Create `Dockerfile`:

```dockerfile
FROM node:24-bookworm-slim AS node
FROM composer:2 AS composer

FROM php:8.4-cli-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY analyzers/php/composer.json analyzers/php/composer.lock analyzers/php/
RUN composer install \
    --working-dir=analyzers/php \
    --no-dev \
    --no-interaction \
    --no-progress \
    --prefer-dist \
    --classmap-authoritative

COPY . .

CMD ["node", "bin/review.js", "--help"]
```

This keeps `npm prepare` from trying to install Git hooks inside the image and keeps Composer vendor in an image layer.

- [ ] **Step 4: Put the complete in-container gate in one script**

Create `bin/test-docker.sh`:

```sh
#!/bin/sh
set -eu

find analyzers/php/bin analyzers/php/src evaluation \
  -name '*.php' -print0 \
  | xargs -0 -n1 php -l

npm run test:all
```

- [ ] **Step 5: Add only the build and test scripts**

Update the beginning of `package.json` scripts to:

```json
{
  "scripts": {
    "docker:build": "docker build --tag reviewer:local .",
    "test:docker": "npm run docker:build && docker run --rm --network none reviewer:local sh bin/test-docker.sh",
    "lint": "eslint bin src tests evaluation",
    "prepare": "simple-git-hooks",
    "test": "node --test",
    "test:safety": "node --test",
    "test:e2e": "node --test tests/e2e/*.test.js",
    "test:all": "npm run lint && npm run test:safety && npm run test:e2e && npm run test:coverage && npm run eval:mutations && npm run eval:historical",
    "test:coverage": "c8 --all --include='src/**/*.js' --check-coverage --lines 90 --functions 90 --branches 85 --statements 90 npm run test:safety",
    "eval:mutations": "node evaluation/mutations/run.js",
    "eval:historical": "node evaluation/historical/run.js",
    "eval:real-repo": "node evaluation/real-repo/cli.js"
  }
}
```

Keep the existing `simple-git-hooks` and `devDependencies` objects unchanged. Removing `analyzer:install` is intentional: no supported host workflow should call Composer.

- [ ] **Step 6: Build and run the full gate**

Run:

```bash
npm run test:docker
```

Expected: Docker builds `reviewer:local`; PHP syntax lint passes; lint, safety, E2E, coverage, mutation evaluation and historical evaluation all pass.

- [ ] **Step 7: Verify the build did not leak dependencies to the host**

Run:

```bash
test ! -e analyzers/php/vendor/autoload.php
git status --short
```

Expected: no host PHP vendor exists. Status contains only the task's intended files plus the pre-existing modification to `docs/tasks/2026-08-12-review-reduction-next-phase.md`.

- [ ] **Step 8: Commit the image and gate**

```bash
git add Dockerfile .dockerignore bin/test-docker.sh package.json
git commit -m "build: run reviewer gate in Docker"
```

### Task 2: Run PR review through a read-only offline container

**Files:**
- Create: `bin/review-docker.sh`
- Modify: `package.json:4-17`

- [ ] **Step 1: Record the missing Docker review entrypoint**

Run:

```bash
npm run review:docker -- --base HEAD --head HEAD --json
```

Expected: FAIL with `Missing script: "review:docker"`.

- [ ] **Step 2: Add the host wrapper**

Create `bin/review-docker.sh`:

```sh
#!/bin/sh
set -eu

image=${REVIEWER_DOCKER_IMAGE:-reviewer:local}
requested_target=${REVIEW_TARGET:-$PWD}

if ! target=$(git -C "$requested_target" rev-parse --show-toplevel 2>/dev/null); then
  echo "error: REVIEW_TARGET is not a Git repository: $requested_target" >&2
  exit 2
fi

run_review() {
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0=/target \
    -v "$target:/target:ro" \
    "$@"
}

if [ -n "${REVIEW_OUTPUT_DIR:-}" ]; then
  if ! output=$(cd "$REVIEW_OUTPUT_DIR" 2>/dev/null && pwd -P); then
    echo "error: REVIEW_OUTPUT_DIR does not exist: $REVIEW_OUTPUT_DIR" >&2
    exit 2
  fi
  run_review -v "$output:/output:rw" \
    "$image" node bin/review.js --repo /target "$@"
else
  run_review "$image" node bin/review.js --repo /target "$@"
fi
```

The helper only removes duplicated `docker run` flags. It does not create a Docker abstraction or alter adapter behavior.

- [ ] **Step 3: Add the npm entrypoint**

Add this script next to `docker:build` in `package.json`:

```json
"review:docker": "npm run docker:build && sh bin/review-docker.sh",
```

- [ ] **Step 4: Verify target validation fails before Docker starts**

Run:

```bash
REVIEW_TARGET=/tmp/no-such-reviewer-repository \
  npm run review:docker -- --base HEAD --head HEAD
```

Expected: exit 2 with `REVIEW_TARGET is not a Git repository`.

- [ ] **Step 5: Verify review works without network or host PHP**

Run:

```bash
test -z "$(command -v php || true)"
test -z "$(command -v composer || true)"
npm run review:docker -- --base HEAD --head HEAD --json
```

Expected: JSON report with zero changed files and a successful `NOT_SELECTED_FOR_HUMAN_REVIEW` decision. Docker runs with the target mounted read-only and `--network none`.

- [ ] **Step 6: Verify the explicit output mount**

Run:

```bash
review_output=$(mktemp -d)
REVIEW_OUTPUT_DIR="$review_output" \
  npm run review:docker -- \
  --base HEAD --head HEAD --json --out /output/report.json
test -s "$review_output/report.json"
rm -r "$review_output"
```

Expected: report exists in the explicitly mounted temporary directory; no file is written through `/target`.

- [ ] **Step 7: Commit the review wrapper**

```bash
git add bin/review-docker.sh package.json
git commit -m "feat: run reviewer CLI in Docker"
```

### Task 3: Make CI use the same image and gate

**Files:**
- Modify: `.github/workflows/review-reduction-safety.yml:12-38`

- [ ] **Step 1: Confirm CI still owns duplicate runtime setup**

Run:

```bash
rg -n 'setup-node|setup-php|npm ci|composer install' \
  .github/workflows/review-reduction-safety.yml
```

Expected: matches for the four host setup/install operations.

- [ ] **Step 2: Replace host setup with the image gate**

Keep checkout and replace every later step with:

```yaml
      - name: Build Reviewer image
        run: docker build --tag reviewer:ci .

      - name: Run full release gate
        run: docker run --rm --network none reviewer:ci sh bin/test-docker.sh
```

The complete workflow becomes:

```yaml
name: Review Reduction Safety

on:
  push:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  safety:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Build Reviewer image
        run: docker build --tag reviewer:ci .

      - name: Run full release gate
        run: docker run --rm --network none reviewer:ci sh bin/test-docker.sh
```

- [ ] **Step 3: Verify workflow and local gate commands**

Run:

```bash
rg -n 'setup-node|setup-php|composer install' \
  .github/workflows/review-reduction-safety.yml
npm run test:docker
```

Expected: `rg` returns no matches; Docker full gate passes.

- [ ] **Step 4: Commit CI parity**

```bash
git add .github/workflows/review-reduction-safety.yml
git commit -m "ci: verify reviewer through Docker"
```

### Task 4: Document the Docker-only host workflow and perform final acceptance

**Files:**
- Modify: `README.md:35-58,176-197`
- Modify: `evaluation/real-repo/README.md:7-15`
- Modify: `docs/safety-mvp-architecture.md` release-gate section
- Modify: `docs/operations/safety-mvp-next-phase.md:18-30`

- [ ] **Step 1: Confirm documentation still instructs host Composer usage**

Run:

```bash
rg -n 'analyzer:install|npm run test:all' \
  README.md evaluation/real-repo/README.md \
  docs/safety-mvp-architecture.md docs/operations/safety-mvp-next-phase.md
```

Expected: current host installation and direct gate instructions are reported.

- [ ] **Step 2: Replace README quick start with Docker commands**

Replace the analyzer install/review example with:

````markdown
本機只需要 Node/npm、Git 與 Docker；PHP、Composer 與 PHP vendor 都封裝在 image 內。

```bash
npm run review:docker -- --base origin/master --head HEAD
```

Review 其他 repository：

```bash
REVIEW_TARGET=/path/to/project \
  npm run review:docker -- --base origin/master --head HEAD
```

需要 `--out` 時，明確掛載輸出目錄並使用 container path：

```bash
REVIEW_OUTPUT_DIR=/path/to/output \
  npm run review:docker -- \
  --base origin/master --head HEAD --out /output/report.json
```
````

Replace the release-gate setup and command with:

````markdown
## Release gate

```bash
npm run test:docker
```

此命令建置包含 Node 24、PHP 8.4、Composer 與鎖定 vendor 的 image，再於無網路 container 內執行 PHP syntax lint 與完整 `npm run test:all`。Host 不需要安裝 PHP 或 Composer。
````

Keep the existing list of gate contents.

- [ ] **Step 3: Correct the real-repo evaluation quick start**

Replace `evaluation/real-repo/README.md` lines 7-15 with:

````markdown
## 快速開始

Real-repo evaluation 也在 Reviewer image 內執行。Target repositories 唯讀掛載；output directory 是唯一可寫的 host mount：

```bash
npm run docker:build
mkdir -p real-repo-eval-output

docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  -e GIT_CONFIG_COUNT=2 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0=/repos/shop \
  -e GIT_CONFIG_KEY_1=safe.directory \
  -e GIT_CONFIG_VALUE_1=/repos/admin \
  -v /path/to/shop-api:/repos/shop:ro \
  -v /path/to/admin-api:/repos/admin:ro \
  -v "$PWD/real-repo-eval-output:/output:rw" \
  reviewer:local \
  node evaluation/real-repo/cli.js evaluate \
  --repo shop=/repos/shop \
  --repo admin=/repos/admin \
  --out /output
```

上例不使用 `--baseline-ref`，因此 runtime 可保持無網路。需要替不同 lockfile 建立 baseline vendor 時，另行建立包含該 lockfile 的 image，不在 runtime 開放網路安裝依賴。
````

- [ ] **Step 4: Correct architecture and operations gate commands**

Replace the release-gate block in `docs/safety-mvp-architecture.md` with:

````markdown
Host 與 CI 的 release gate：

```bash
npm run test:docker
```

Image 內由 `sh bin/test-docker.sh` 先執行 PHP syntax lint，再執行既有 `npm run test:all`。PHP、Composer 與 vendor 不安裝到 host。
````

Replace lines 19-28 of `docs/operations/safety-mvp-next-phase.md` with:

````markdown
## Release gate

本機與 CI 使用同一個 Docker image。Host 只需 Node/npm、Git 與 Docker：

```bash
npm run docker:build
npm run test:docker
```

`test:docker` 在無網路 container 內先執行 PHP syntax lint，再執行 `test:all`。其中 `test:safety` 使用遞迴 `node --test`，`test:e2e` 明確執行 `tests/e2e/*.test.js`（Node.js 24.3 不接受目錄作為 test input），`test:coverage` 的最低門檻為 lines/functions/statements 90%、branches 85%。測試不依賴網路、LLM、真實 GitHub token 或 production credential。
````

- [ ] **Step 5: Verify documentation has no supported host Composer path**

Run:

```bash
rg -n 'analyzer:install' README.md evaluation/real-repo/README.md \
  docs/safety-mvp-architecture.md docs/operations/safety-mvp-next-phase.md
```

Expected: no matches.

- [ ] **Step 6: Run final acceptance from a host without PHP/Composer**

Run:

```bash
test -z "$(command -v php || true)"
test -z "$(command -v composer || true)"
test ! -e analyzers/php/vendor/autoload.php
npm run test:docker
npm run review:docker -- --base HEAD --head HEAD --json
test ! -e analyzers/php/vendor/autoload.php
git diff --check
```

Expected: every command exits 0; the full gate passes in Docker; review emits a valid zero-file JSON report; host PHP vendor remains absent; diff check is clean.

- [ ] **Step 7: Review container safety and scope**

Run:

```bash
rg -n -- '--network none|--read-only|/target:ro|/output:rw|safe.directory' \
  bin/review-docker.sh package.json .github/workflows/review-reduction-safety.yml
git diff --stat 5ca5716..HEAD
git status --short --branch
```

Expected: review runtime shows offline/read-only target controls; only the optional output mount is writable; changes are limited to the file map above; the pre-existing task-document modification remains uncommitted and untouched.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md evaluation/real-repo/README.md \
  docs/safety-mvp-architecture.md docs/operations/safety-mvp-next-phase.md
git commit -m "docs: document Docker-only reviewer workflow"
```

- [ ] **Step 9: Run final branch review**

Run:

```bash
git log --oneline 5ca5716..HEAD
git diff --check 5ca5716..HEAD
git status --short --branch
```

Expected: four focused implementation commits follow the design commit; diff check passes; only the pre-existing `docs/tasks/2026-08-12-review-reduction-next-phase.md` modification remains outside those commits.
