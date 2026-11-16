#!/usr/bin/env bash
# One review round of the current branch's commits (.agents/skills/ship-pr/REVIEW.md):
#
#   scripts/review.sh claude [--base <ref>]   # Claude Opus, xhigh, as the pr-reviewer agent
#   scripts/review.sh codex  [--base <ref>]   # Codex on gpt-6-astra, xhigh
#
# The reviewer works in a throwaway detached worktree of HEAD, never in the
# caller's tree: its scratch tests can't reach a commit, and half-done edits
# can't break its runs. Uncommitted changes are not reviewed. The findings
# go to <git common dir>/reviews/ (outside every worktree) and to stdout.
# Exit 3: Codex stopped on its usage limit, so the round did not happen.
#
# The reviewers' models and efforts live here and nowhere else. `opus` is
# the alias of the latest Opus. REVIEW_CLAUDE_MODEL / REVIEW_CODEX_MODEL
# override them for one run.
set -euo pipefail

CLAUDE_MODEL="${REVIEW_CLAUDE_MODEL:-opus}"
CLAUDE_EFFORT=xhigh
CODEX_MODEL="${REVIEW_CODEX_MODEL:-gpt-6-astra}"
CODEX_EFFORT=xhigh

WHO="${1:-}"
case "$WHO" in
  claude | codex) shift ;;
  *)
    echo "usage: scripts/review.sh claude|codex [--base <ref>]" >&2
    exit 2
    ;;
esac
BASE=origin/main
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      BASE="${2:?--base needs a ref}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
git -C "$ROOT" fetch -q origin main
SHA="$(git -C "$ROOT" rev-parse HEAD)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD | tr '/' '-')"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are not part of this review (it reviews $SHA)" >&2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/review.XXXXXX")"
WT="$TMP/tree"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WT" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$ROOT" worktree add -q --detach "$WT" "$SHA"
if ! (cd "$WT" && { pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile; }) \
  > "$TMP/install.log" 2>&1; then
  tail -n 30 "$TMP/install.log" >&2
  echo "pnpm install failed in the review worktree" >&2
  exit 1
fi

mkdir -p "$COMMON/reviews"
OUT="$COMMON/reviews/$BRANCH-$WHO-$(date +%Y%m%d-%H%M%S).md"
echo "reviewing $SHA against $BASE with $WHO; findings → $OUT" >&2

STATUS=0
if [ "$WHO" = claude ]; then
  # Edits are accepted inside the throwaway tree only (probe tests); Bash is
  # limited to reading git and running the repo's own tests and builds.
  printf '%s\n' \
    "Review the commits of this branch against $BASE: \`git diff $BASE...HEAD\`." \
    "Follow your instructions and end with your findings in the format they give." |
    (cd "$WT" && claude -p --agent pr-reviewer --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT" \
      --permission-mode acceptEdits --no-session-persistence \
      --allowedTools "Read,Grep,Glob,Edit,Write,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git grep:*),Bash(git merge-base:*),Bash(pnpm test:*),Bash(pnpm typecheck:*),Bash(pnpm exec vp test:*),Bash(pnpm exec tsc:*),Bash(pnpm --filter:*),Bash(ls:*),Bash(rg:*),Bash(grep:*),Bash(wc:*)") \
      > "$OUT" || STATUS=$?
  if [ "$STATUS" -ne 0 ] || [ ! -s "$OUT" ]; then
    cat "$OUT" >&2
    echo "The Claude review failed (exit $STATUS) or wrote nothing: this round did not happen." >&2
    exit 1
  fi
  cat "$OUT"
  exit 0
fi

(cd "$WT" && "${CODEX_BIN:-codex}" review --base "$BASE" \
  -c "model=\"$CODEX_MODEL\"" -c "model_reasoning_effort=\"$CODEX_EFFORT\"") > "$OUT" 2>&1 ||
  STATUS=$?
# The findings follow Codex's last `codex` line; everything above is its log,
# which may quote any file of the diff (this one included), so only its end
# can tell a usage limit from a finding about one.
FINDINGS="$(awk '/^codex$/ { findings = ""; next } { findings = findings $0 "\n" } END { printf "%s", findings }' "$OUT")"
LIMIT="^(ERROR:? *)?You've hit your usage limit"
if { [ "$STATUS" -ne 0 ] && tail -n 10 "$OUT" | grep -qiE "$LIMIT"; } ||
  printf '%s\n' "$FINDINGS" | grep -m 1 . | grep -qiE "$LIMIT"; then
  tail -n 5 "$OUT" >&2
  echo "Codex hit its usage limit: this round did not happen and is still owed." >&2
  exit 3
fi
if [ "$STATUS" -ne 0 ]; then
  tail -n 30 "$OUT" >&2
  echo "The Codex review failed (exit $STATUS): this round did not happen." >&2
  exit "$STATUS"
fi
printf '%s\n' "$FINDINGS"
