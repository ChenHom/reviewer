#!/bin/sh
set -eu

image=${REVIEWER_DOCKER_IMAGE:-reviewer:local}
requested_target=${REVIEW_TARGET:-$PWD}

if ! target=$(git -C "$requested_target" rev-parse --show-toplevel 2>/dev/null); then
  echo "error: REVIEW_TARGET is not a Git repository: $requested_target" >&2
  exit 2
fi
git_dir=$(git -C "$target" rev-parse --absolute-git-dir)
git_common_dir=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)
container_git_dir=/git${git_dir#"$git_common_dir"}

run_review() {
  docker run --rm \
    --network none \
    --read-only \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0=/target \
    -e GIT_DIR="$container_git_dir" \
    -e GIT_WORK_TREE=/target \
    -v "$target:/target:ro" \
    -v "$git_common_dir:/git:ro" \
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
