#!/bin/sh
set -eu

image=${REVIEWER_DOCKER_IMAGE:-reviewer:local}
requested_target=${REVIEW_TARGET:-$PWD}
network=none
target_access=ro
mode=${1:-}

case "$mode" in
  offline|ai) shift ;;
  *) echo "error: use npm run review:docker or npm run review:docker:ai" >&2; exit 2 ;;
esac

if [ "$mode" = ai ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    echo "error: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for review:docker:ai" >&2
    exit 2
  fi
  network=bridge
  set -- --ai "$@"
fi

for option do
  case "$option" in
    --ai|--ai-*|--ai=*)
      if [ "$network" = none ]; then
        echo "error: use npm run review:docker:ai for AI review" >&2
        exit 2
      fi
      ;;
  esac
  if [ "$option" = --ai-apply ]; then
    target_access=rw
  fi
done

if ! target=$(git -C "$requested_target" rev-parse --show-toplevel 2>/dev/null); then
  echo "error: REVIEW_TARGET is not a Git repository: $requested_target" >&2
  exit 2
fi
git_dir=$(git -C "$target" rev-parse --absolute-git-dir)
git_common_dir=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)
container_git_dir=/git${git_dir#"$git_common_dir"}

run_review() {
  if [ "$network" = bridge ]; then
    set -- -e ANTHROPIC_API_KEY -e ANTHROPIC_AUTH_TOKEN "$@"
  fi
  docker run --rm \
    --network "$network" \
    --read-only \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0=/target \
    -e GIT_DIR="$container_git_dir" \
    -e GIT_WORK_TREE=/target \
    -v "$target:/target:$target_access" \
    -v "$target/.git:/target/.git:ro" \
    -v "$git_common_dir:/git:ro" \
    "$@"
}

if [ -n "${REVIEW_OUTPUT_DIR:-}" ]; then
  # 以哨兵 . 結尾，避免 $(...) 吃掉路徑本身結尾的換行；再去掉哨兵與 pwd 自己的換行
  if ! output=$(CDPATH= cd -P -- "$REVIEW_OUTPUT_DIR" >/dev/null 2>&1 && pwd -P && echo .); then
    echo "error: REVIEW_OUTPUT_DIR does not exist: $REVIEW_OUTPUT_DIR" >&2
    exit 2
  fi
  newline='
'
  output=${output%.}
  output=${output%"$newline"}
  case "$REVIEW_OUTPUT_DIR$output" in
    *"$newline"*) echo "error: REVIEW_OUTPUT_DIR must not contain a newline" >&2; exit 2 ;;
  esac
  # 壓掉重複的 /，讓 / 與 // 也成為 metadata 的上層目錄而被拒絕
  output_prefix=$(printf '%s/' "$output" | tr -s /)
  for metadata in "$target/.git" "$git_common_dir"; do
    case "$output_prefix" in
      "$metadata/"*) echo "error: REVIEW_OUTPUT_DIR overlaps Git metadata" >&2; exit 2 ;;
    esac
    case "$metadata/" in
      "$output_prefix"*) echo "error: REVIEW_OUTPUT_DIR overlaps Git metadata" >&2; exit 2 ;;
    esac
  done
  run_review -v "$output:/output:rw" \
    "$image" node bin/review.js --repo /target "$@"
else
  run_review "$image" node bin/review.js --repo /target "$@"
fi
