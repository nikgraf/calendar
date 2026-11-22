---
name: ship-pr
description: How every change in this repo becomes a pull request Nik can merge — the branch, the commits, the self-check, the review rounds (Claude Opus, then Codex), screenshots for each platform, the PR body, the draft that gets its number, the decisions record, and what happens after the merge. Use for every PR, from the first edit on, not only at the end.
---

# Ship a PR

Nik merges a PR as soon as it is green and looks done, and he does not
want work pushed after he merged. So a PR is finished before anyone can
merge it: review rounds run, screenshots taken, decisions recorded. The
`PR complete` check (`.github/workflows/pr-complete.yml`,
`scripts/check-pr-complete.ts`) fails a ready PR whose body misses any of
it. Never merge, and never push to `main`.

Agent sessions keep no memory between runs. Anything the next session
should know (a tool quirk, a recipe, a rule Nik stated) goes into the doc,
skill or test it belongs to, in this PR. A chat message or a local memory
file is lost with the machine.

## 1. Branch

- Check `main`'s own CI first: `gh run list --branch main --workflow ci.yml -L 3`.
  A red `main` makes every new PR red; fix that first, as its own PR.
- Branch `todo/<slug>` from `origin/main`. A checkout that other sessions
  share (several sessions on one Mac) gets a sibling worktree instead:
  `git worktree add ../calendar-<slug> -b todo/<slug> origin/main`, then
  `pnpm install --frozen-lockfile` in it. Work by absolute path; never
  `cd` into a worktree another session made.
- One PR per task. A feature that spans packages and both apps is one PR
  with ordered commits (risky or spike work first, each commit green), not
  a stack. A batch of related fixes from one origin (one review, one
  incident) is one PR too. Stacks only when Nik asks for them (`STACKS.md`).

## 2. Commits

- The gate before every commit: `pnpm check`, `pnpm knip`, `pnpm typecheck`,
  `pnpm test`. `pnpm fix` applies lint and format fixes.
- The pre-commit hook commits the whole index. Stage by name
  (`git add <paths>`) and look at `git status --short` first; never
  `git add -A`, above all while a subagent works in the tree. A commit the
  hook rejected leaves its files staged, and the next commit swallows them.
- Before a "revert the fix, watch the test fail" experiment, make a WIP
  commit (or `git diff > <scratch>/fix.patch`): `git checkout <file>`
  restores the whole file, not just the experiment.
- Throwaway specs and probes live outside the repo or under a gitignored
  name (`apps/desktop/e2e/_*.e2e.ts`); they never land in a commit.
- Rewrite only what was never pushed. To reword or fold unpushed commits
  without an interactive rebase: `git commit --fixup=<sha>` (or
  `--fixup=amend:<sha>` / `reword:<sha>` with `GIT_EDITOR` set to a script
  that writes the new message), then
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main`.
  Never rebuild them with `git reset --soft origin/main`: `scripts/review.sh`
  fetches, so `origin/main` may be past your base, and the next commit
  then undoes what `main` gained in every file it holds (#349). Reset to
  `git merge-base origin/main HEAD`, or rebase first.
- Once pushed, every change is a new commit: Nik squash-merges, so the
  history on the branch doesn't matter. A force-push needs Nik's yes, and
  then goes as `--force-with-lease=<branch>:<old sha>`.

## 3. Tests that prove the change

- A bug fix comes with a test that fails on `main`. Prove it: save the fix
  as a patch, `git checkout --` the source paths, build what the test runs
  against (`pnpm --filter @calendar/desktop build` for desktop e2e), run the
  test, `git apply` the patch, rebuild.
- A flaky e2e that exposes an app race: fix the app, not the test. Keep
  the test's fast sequence so it keeps exercising the race, and add a
  deterministic regression test. A test-side wait that would also hide the
  race needs Nik's say: report the trade-off instead of adding it.
- e2e conventions (dates relative to today, `locate`, `data-testid`,
  fixture accounts) are in `docs/google-sync-and-testing.md`.
- macOS CI minutes are limited. Run the affected desktop specs and Maestro
  flows locally before pushing; push fixes in batches, not one per try.
  `pnpm test:e2e` skips the property specs: a change to how events or
  to-dos are saved also runs `pnpm test:bombadil` (CI's desktop job does).

## 4. Self-check before review

Read your own diff (`git diff origin/main...HEAD`) against `SELF-CHECK.md`:
the bug classes earlier review rounds kept finding here. Fix what it turns
up before the first round, so the rounds spend their time on new bugs.

## 5. Review rounds

Every PR, without asking: first Claude Opus, then Codex. `REVIEW.md` has
the commands. In short:

1. `scripts/review.sh claude` — 1 to 2 rounds. Stop after a clean round or
   after the second.
2. `scripts/review.sh codex` — at least 1 round even when Opus came back
   clean, at most 2. Stop after a clean round or after the second.

Each round reviews the committed branch against `origin/main` in a
throwaway worktree; it needs no push. Verify every finding against the
code before acting on it. A confirmed one gets a failing test, then the
fix, then the gate; a rejected one gets a sentence on why. Record each
round in the body (step 7). If Codex cannot run (usage limit), its round
is still owed: an extra Opus round does not replace it. Keep the PR a
draft, say so in the body and tell Nik.

## 6. Screenshots

A PR that changes UI shows it, one screenshot per platform it touches
(iOS, Desktop): a before/after pair when an existing screen changes, a
dark pair when colors change. Fixture data only. `SCREENSHOTS.md` has the
capture recipes for both apps and how the images are hosted (the
`pr-screenshots` branch, never the feature branch). A platform that can't
be captured is named in the body with the reason; never leave it out
silently.

## 7. The PR body

Start from `.github/pull_request_template.md` (`gh pr create --body-file`
does not read it for you).

- An opening line on what the PR does.
- `## What changes for the user` first: bullets, each led by a bold phrase
  naming the change as the user meets it, then what they now see or can
  do, then what happened before. Name each platform when they differ (iOS,
  Desktop). The screenshots go here. A change with nothing visible keeps
  the section and says so in one line ("Nothing visible: sync retries move
  to the op queue.").
- `## Decisions`: what was decided, what was rejected and why, what is
  left as it is.
- `## Tests`: what proves it and what ran locally, on which build.
- `## After review (Claude Opus 5.5, xhigh)` and
  `## After review (Codex, gpt-6-astra, xhigh)`: per round, what was found,
  what was fixed (with the commit) and what was left as is and why. Name
  the model and effort that actually ran.
- Nothing "still to come": a PR that owes something stays a draft.

## 8. Open, number, record

Parallel sessions open PRs within minutes of each other, so never predict
the next number.

1. Push the branch and open a draft:
   `gh pr create --draft --base main --title "<what changes, in words>" --body-file <body.md>`.
   A push over HTTPS with `gh`'s token is refused for a change under
   `.github/workflows/` unless the token has the `workflow` scope
   (`gh auth refresh -s workflow`, which needs Nik). If SSH to port 22
   hangs, push over 443: `ssh://git@ssh.github.com:443/nikgraf/calendar.git`
   with GitHub's host keys (`gh api meta --jq '.ssh_keys[]'`, each prefixed
   `[ssh.github.com]:443 `) in a scratch `known_hosts`.
2. Read its number and commit the record in `docs/decisions.md` under its
   area, citing `(#<n>)`: the decision, the alternatives rejected, what it
   leaves open — ten lines at most. The mechanism goes in the current-state
   doc it belongs to, never the log. A record this PR reverses, and an
   open point it closes, leave the log in the same commit (the new record
   names the PR it replaced). A shipped `todo.md` item leaves `todo.md` in
   the same commit. A PR with nothing to record (a test fix, a
   dependency bump) says `No decisions entry: <why>.` in its body.
3. Push again (CI cancels the superseded run) and update the body:
   `gh pr edit <n> --body-file <body.md>`.
4. Check what the `PR complete` check will say:
   `GITHUB_TOKEN=$(gh auth token) node scripts/check-pr-complete.ts <n> --ready`.
5. Tell Nik it is complete and ask him to mark it ready. Run
   `gh pr ready <n>` yourself only when he asked for that.

## 9. CI and after

- CI: the gate, the macOS desktop e2e, the iOS e2e and `PR complete`.
  `PR complete` is a commit status, set by the `Post PR complete` job: a
  body edit runs it again and the new verdict replaces the old one. That
  job itself goes red only when its run broke; rerun it.
  A failure on CI only: reproduce locally first (`docs/google-sync-and-testing.md`
  → CI lists the known flakes and how to tell them from a real failure).
- A batch of separate PRs opened together can each be green and still
  break `main` together. Trial-merge them:
  `git switch -c tmp/merge-check origin/main`, merge every branch, run the
  gate (and the desktop e2e when shared code moved), delete the branch.
- After Nik merged, a follow-up is a new PR off the merged `main`, never a
  push to the merged branch.
