# Stacked PRs

Prefer one PR with ordered commits. Stack only when Nik asks for it. A
stack in this repo has two traps, both because Nik squash-merges and the
repo keeps merged head branches (automatic deletion is off).

## A base that merged

Open a stacked PR with `--base todo/<base-slug>` and "Stacked on #N" in its
body. When the base PR merges, retarget the stacked one at once:
`gh pr edit <n> --base main`, and tell Nik. GitHub does not do it while the
base branch still exists, and a PR merged into a dead base never reaches
`main` (#174 had to be re-landed by cherry-pick in #177). Before opening a
stacked PR, check whether its base merged in the meantime; if it did,
target `main` directly.

## Conflicts after the base's squash

Right after the base lands, the stacked PR conflicts with `main` on the
base's own lines: `main` holds the base as one new commit, the branch
still holds its original commits, and git's merge base is the old fork
point. Resolve with a merge commit (no rebase, so no force-push):

1. In the stacked branch's worktree: `git merge --no-commit origin/main`.
2. For every file of the PR's own change set, not only the conflicted
   ones, three-way merge by hand and take the result:
   `git merge-file -p <file at the branch tip> <file at the base PR's last commit> <file at origin/main>`.
   When the base branch was rebased before its squash, its rebased tip
   (`origin/<base branch>`) is the base to use. A file git reports as
   cleanly merged can still be wrong (an import the branch removed came
   back once).
3. Never `git checkout --ours <file>` while `main` has moved past the
   base: it takes the whole file and drops `main`'s cleanly merged hunks
   in it. Recreate the markers with `git checkout -m <file>` and resolve
   only inside them.
4. Prove it. If `main`'s tree equals the old base's tree
   (`git diff --stat <old base head> origin/main` is empty), the merged
   tree must equal the PR's tree before the merge
   (`git diff --cached --stat <PR head before>` empty). Otherwise the
   staged diff over the PR's old head must touch exactly the files of
   `main`'s new commits.
5. Check for leftover markers, run the gate, commit the merge, push. Then
   merge the updated branch into any PR stacked on top (that one merges
   clean). On GitHub the PR's file count should stay its own.

In zsh a newline-separated file list in one variable does not split: use
an array or `${(f)var}`.
