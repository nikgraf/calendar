One or two sentences on what this PR does.

## What changes for the user

- **The change as the user meets it (iOS, Desktop).** What they now see or can do. What happened before.

<!--
A UI change shows it here, one screenshot per platform it touches; a
before/after pair when an existing screen changes, a dark pair when colors
change (.agents/skills/ship-pr/SCREENSHOTS.md):

| iOS | Desktop |
| --- | --- |
| <img width="300" src="https://github.com/nikgraf/calendar/blob/pr-screenshots/<branch-slug>/ios-after.png?raw=true"> | <img width="600" src="https://github.com/nikgraf/calendar/blob/pr-screenshots/<branch-slug>/desktop-after.png?raw=true"> |

A platform that can't be captured says so: "No iOS screenshot: <why>."
A change with nothing visible keeps this section and says so in one line:
"Nothing visible: <what changes underneath>."
-->

## Decisions

- **The decision.** Why. Rejected: the alternative, and why not.
- **Left as they are:** what this PR leaves open.

## Tests

- **Unit:** the new and changed tests, and what each proves.
- **Desktop e2e:** specs added or changed; what ran locally.
- **iOS Maestro:** flows added or changed; what ran locally, on which build.
- **Gate:** `pnpm check`, `pnpm knip`, `pnpm typecheck`, `pnpm test`, green on the final code.

## After review (Claude Opus 5.5, xhigh)

- **Round 1** found … Fixed in `<sha>`: …

## After review (Codex, gpt-6-astra, xhigh)

- **Round 1** found … Fixed in `<sha>`: …

<!-- No decisions entry for this PR? Say so in one line: "No decisions entry: <why>." -->
