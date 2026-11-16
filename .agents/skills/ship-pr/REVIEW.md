# Review rounds

Nik's standing rule (since 2026-10-18): every PR gets 1–2 rounds by the
latest Claude Opus at xhigh effort, then 1–2 rounds by Codex on
gpt-6-astra at xhigh, at least one of them even when Opus came back
clean. Rounds run in that order; don't ask whether to run them.

## Running a round

```sh
scripts/review.sh claude            # Opus round
scripts/review.sh codex             # Codex round
scripts/review.sh codex --base <ref>   # against another base (default origin/main)
```

The script fetches `origin/main`, checks the current `HEAD` out into a
throwaway detached worktree, installs dependencies there (offline from the
store when it can), runs the reviewer in it and removes it afterwards. The
reviewer never sees your working tree, so its scratch tests can't end up
in your commit and your half-done edits can't break its runs. It reviews
commits only: commit first. The findings land in
`<git common dir>/reviews/<branch>-<reviewer>-<time>.md`, and the script
prints the path.

- **Claude** runs headless as the `pr-reviewer` agent
  (`.claude/agents/pr-reviewer.md`, its instructions and output format)
  with `--model opus --effort xhigh`. `opus` is the alias of the latest
  Opus; pin a full model id with `REVIEW_CLAUDE_MODEL` only to repeat a
  run. A Claude session may run the same agent as a subagent instead, but
  then it shares your worktree: stage by name and keep your edits away
  from the files it reads until it reports.
- **Codex** runs `codex review --base <base>` with model `gpt-6-astra` and
  `model_reasoning_effort` `xhigh` (`REVIEW_CODEX_MODEL` overrides the
  model). It pins `review_model` too, which would otherwise win over
  `model` for a review, and a log whose header names another model exits
  1: that round does not count. It reads `AGENTS.md` on its own. Findings follow its last
  `codex` line as `- [P1|P2|P3] title — path:line` plus a paragraph. It
  writes and deletes its own ad-hoc tests. Its sandbox cannot listen on
  sockets or write `node_modules/.vite-temp`, so suite runs that need a
  socket fail with `listen EPERM` and `vp check` fails with `EPERM`:
  noise, not findings. Its targeted test runs still work.
- A Codex round takes 5–60 minutes depending on the diff. Run it in the
  background and keep working on what doesn't touch the reviewed code.
- The script exits 3 when Codex stopped on its usage limit ("You've hit
  your usage limit … try again at …"). That round did not happen. The
  limit often lifts before the time it names: retry later. If it still
  holds when everything else is done, the PR stays a draft with
  "Codex round owed: usage limit until <time>" in its body, and Nik hears
  about it.

## Acting on findings

1. Verify each finding against the code: read the path end to end, and
   where it's cheap, reproduce it. Most findings from both reviewers have
   held up here, so expect them to be real, but never fix one you have not
   confirmed.
2. A confirmed finding: a test that fails without the fix, then the fix,
   then the gate. One commit per round's fixes is fine. A reviewer's
   suggested fix is a suggestion: check every caller and every producer
   of the path it touches before adopting it (a fallback a reviewer
   proposed for one queue op broke another op that shares its shape).
   The next round reviews the fix too.
3. A rejected finding, or one left as it is on purpose: one sentence in
   the body on why.
4. Before the next round, run `SELF-CHECK.md` again on the fix commit
   alone: a fix brings in the next round's bug often enough, and the same
   bug often sits in a sibling path.
5. Next round on the new `HEAD`. Stop that reviewer after a clean round or
   after its second.

## What the rounds have found

Counted over #176–#335 (1,072 confirmed findings, 2026-11-16), to weigh
the rule against:

- Most findings hold up: Opus's were confirmed 87% of the time (most of
  the rest were older bugs or design calls left as they are), Codex's 98%.
- Two rounds don't converge: a second round of either reviewer still found
  something real in 76% of rounds.
- The two find different things. Codex leans toward sync-queue outcomes,
  "don't know" read as an answer and fields dropped on a rebuild; Opus
  toward tests, fakes, failure handling, resources, docs and copy. On the
  95 PRs both reviewed: both found real bugs in 51, only Opus in 31, only
  Codex in 1.
- A Codex round after Opus came back clean rarely found one: 3 of 24 PRs.
  After an Opus round that was still finding things, Codex found a real
  bug 61% of the time.

## Recording a round

One section per reviewer, named after what actually ran:

```md
## After review (Claude Opus 5.5, xhigh)

- **Round 1** found three problems. All were fixed in `b89274da`:
  - **The bold gist of the finding.** What went wrong and for whom; the fix.
- **Round 2** confirmed those fixes and found nothing new.
- Left as is: … and why.

## After review (Codex, gpt-6-astra, xhigh)

- **Round 1** found …
```

A finding that turns out to be a class the self-check should have caught
goes into `SELF-CHECK.md` in the same PR.
