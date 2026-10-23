#!/bin/sh
set -eu

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init --initial-branch=main --quiet
  git config user.email reviewer@local
  git config user.name reviewer
  git add .
  GIT_AUTHOR_DATE='1970-01-01T00:00:00Z' GIT_COMMITTER_DATE='1970-01-01T00:00:00Z' git commit --quiet -m snapshot
fi

find analyzers/php/bin analyzers/php/src evaluation -type f -name '*.php' -print0 | xargs -0 -n 1 php -l
npm run test:all
