# Self-check

The bug classes review rounds kept finding here, from the 1,072 confirmed
findings on #176–#335, as questions to answer from your own diff
(`git diff origin/main...HEAD`). Skip a group the diff doesn't touch. Run
it before the first review round, and again on each round's fix commit:
about one finding in fifty was a bug the previous round's fix brought in,
and another sat in a sibling path of a bug already fixed ("the same race
in the inspector next to the editor").

A class this list misses that a round finds goes in here, in the PR that
found it.

## Words that must match the code

The class found in the most PRs (54), almost all by Opus.

- For every comment, doc line, commit message and PR-body sentence the
  diff touches or makes stale: does the code now do exactly that? A
  renamed thing still named the old way in captions, fallbacks or the
  README; a version or a guarantee no check proves ("only in the live
  test account").
- Copy that promises something (`PRIVACY.md`, the website, Settings
  text): which code proves each sentence? "Nothing leaves the Mac" was
  false once find a time could reach a server.
- The `docs/decisions.md` record: ten lines at most, citing the PR's
  number or branch (never a placeholder), the decision rather than the
  mechanism.

## Tests

- Revert the non-test part of the change: does this exact assertion fail?
  A string-built CDP wait like `` `${x} ?? null === 'v'` `` parses as
  `x ?? (null === 'v')` and passes on any text (#230, #317).
- Which branch, ordering or failure path did you add that no test fails
  without? Name the test for each.
- A round trip between mounted editors or models: does each side change
  to distinct values before switching? Reusing the original values can
  hide missing field adoption even when every assertion passes.
- Does the test rely on a fake behaving like the real thing (a released
  recorder that throws, EventKit's DST hours, a clock frozen through
  sleep)? Does the fake?
- For generated fault sequences, does an assertion prove each required
  fault reached a write? Does the model allow the engine's documented
  intermediate states, including a conflict after our own lost write?
- Does a seed or an assertion depend on UTC versus local time, "today", a
  weekday or the Sunday week edge, or millisecond ordering of `createdAt`?
- If an e2e spec or a live flow dies at any step and is retried, does the
  rerun start clean, and does the teardown still run after a hang (a
  `finally` after a hang never ran Delete)?
- Adding a test id: did you search existing specs for selectors that rely
  on its absence, such as `:not([data-testid])`, and update those consumers?

## Answers that arrive late

- For each await whose answer lands in a draft or on screen (a turn, a
  probe, the typeahead, MapKit, a write's reply, a series' late rule):
  what if the user switched draft, edited the field, changed scope or
  closed first? Does the answer carry and check its target and inputs (the
  `landRefinement` / `landPlacement` pattern)?
- Does every offered chip, slot, pin or question go away when the input
  it was computed from changes (`livePlaceChoice`)?
- Does a write send a whole struct from an earlier read (settings editor,
  onboarding, a token cache), or read a row outside the transaction that
  writes it? Would two quick changes lose one?
- An async status or probe (a model provider's Test, a download check):
  does it re-validate its inputs after the await, and is its result
  tagged with what it tested, so a URL edited meanwhile isn't shown as
  tested? A stored secret records the origin it belongs to.
- Can it be started twice, stopped twice, or torn down while starting? Is
  the slot taken before the work starts (`useAction`)?
- Does a hidden but mounted screen still listen, take keys or feed a
  comparison? Does a window opened late get the current state when it
  subscribes (`notifications:take`, `lesson:take`)?

## Forms and drafts

- Is everything derived from live form fields fine with `''` and partial
  values?
- A form showing one of several items (the draft thread, a capture's
  drafts): does it keep a per-item snapshot of every field it holds?
- Work that reads "the form" after an await: does it check the form still
  shows its target? Keep such landers pure, so the race is a unit test.
- Does a removal prune the undo history that refers to it?
- Does a snapshot keep what Save validates, in the form Save validates it
  (the raw repeat text), not a normalised value?

## Failures and "don't know"

- For each new failure path: does the user see it where they are? Is the
  failure kept out of every cache? Is it scoped to the case or turn rather
  than the whole run? Does the step after it still run?
- Does any read take a lost answer, a 404 on a retry, an empty or failed
  read, a capped expansion, `0` or `[]` as "no", "gone", "done" or
  "forever"? EventKit's `[]` on a failed read is not "deleted"; a move
  whose answer was lost may have landed. Do a read's reach and its
  write's reach agree?
- Does each call get its own time budget, started when the call starts,
  and does a timeout keep what already finished?

## The sync queue (`applyOp.ts`, `mutations.ts`, the engine)

- For each op kind touched, on discard, a 4xx, keep-mine or keep-theirs,
  and a pull landing meanwhile: what does it take along or give back
  (subtasks, a series' exceptions, ops queued behind it)? What snapshot
  does each survivor end with? Can a pending row be left with no op that
  owns it?
- For each op the diff queues, replaces or re-sends: what must land
  first? Does a replacing op, or a re-send after a 412 or 503, keep
  `dropsFrom`, the carried text and the etag?
- Does any write rebuild the item from a subset of its fields and drop
  the rest (guests' optional fields, a Meet link, attachments, every alert
  but the first)?
- Does any path make something Google's copy of an item (the reply to a
  write sent without If-Match, a move's or a create's answer, a page's
  record) while another change of the item still waits? Is that change
  laid over it first (`heldEvents.take`), or does the copy just move on
  (`advanceBefore`) and leave the change's stale fields to read as the
  user's own, sent back over another device's? Test it with a value
  already on Google: a stale field that is absent is not sent by a PATCH,
  and hides the bug (#374, six findings of this one shape).
- Does anything read the queue or a copy and then write a row in two
  steps outside a transaction? The desktop's store answers within the
  fiber's turn; the iPhone's does not, and a discard gets in between.
- Does every write path (Save, Add all, an Assistant turn, a finder
  phrase, Mark as Done, a title trim) apply Save's gate:
  `UnsupportedForProviderError`, the Reminders-only fields, validation?
- Does an agent write's new refusal happen before ask-first approval,
  and does a refusal after approval still return an actionable error?
- Is every part of an identity or dedupe key stable for the item's life
  and unique in its scope? Not the list, a zone-derived day, an id without
  its calendar, the original start, or a prefix.

## Dates and times

- If a recurrence check needs only occurrence starts, does it still work
  for a zero-duration event rather than relying on visible overlap?
- Which zone does each date computation use, and is it the one its
  consumer means? Does it hold in DST's repeated hour, for all-day rows,
  at 23:59 and 24:00, and for `Etc/UTC` aliases?
- Does every path that changes a draft's times keep its end date
  (overnight, 25-hour and Friday-to-Saturday drafts)?
- Does each turn, slot, rename or kind switch date or undate a to-do on
  purpose (`saidDay`)?

## "Changed" and the UI

- Does revealing an item already on screen preserve the current window,
  including a panned week, the second of two days and an agenda's later
  days, or an event continuing from an earlier day? A focus update can
  move a view whose first day follows the focus.
- Is "changed" decided by meaning (values, sets, folded text, an explicit
  value against the default), not by representation (`JSON.stringify` key
  order, a UTC `UNTIL`, alert order)? Does an edit put back read as no
  change, and "Repeat → None" as one?
- Did you look at it at 1024×768, in a 400 px-tall window, in the 560 px
  Settings window, at 320 px wide, with a long string, and after a scroll
  or the keyboard was left over?
- What happens on a second press mid-slide, Escape mid-drag, Cancel
  mid-fade, a lost pointer capture, or a gesture that starts at its end
  state?
- Where does focus go on every way out (Escape, Decline, the scrim)? Is
  each state change announced, and each control its own accessibility
  element?
- iOS: can this push, present or dismiss interleave with another sheet's
  dismissal, a pending push, or a URL routed to `/`? Does `EditorHost` own
  it?

## Resources, upgrades and hot paths

- Is each resource (mic, recorder, camera, the helper, `llama-server`, a
  model context) released on every exit: stop, failure after it started,
  window close, JS reload, backgrounding? Are its `'error'` events
  handled, and can only its owner end it?
- What does the previous build leave that this code now reads: queued
  ops without a new column, `device_settings` rows, old-shape settings or
  answers, a dev client without a new native function?
- What does this compute per keystroke, turn, move or pulled page? Is it
  linear, and cached where it repeats?

## Scripts, CI and the bench

- For each matcher or classifier (`maestroRetry.ts`, a flake rule, a
  guard script or lint): which input it isn't meant for also matches, and
  which form of what it guards slips past?
- Does each script end through `process.exitCode`, never `process.exit`
  with output still piped? Does each shell step `set -o pipefail` and use
  `jq -e`?
- A bench scorer check: which wrong answer still passes? Does any output
  name a blind case? Can two runs in one minute overwrite a report?

## The Assistant

- Does the diff add a word list or a regex that decides what a phrase
  means? That is out (`AGENTS.md` → Working here). A closed vocabulary
  (dates, times, repeats) that stays: run it over negation, German and
  compound forms, a venue named like a weekday, and the bench.
- The place gate: do MapKit's spellings (short forms, region codes, a
  city in the name, "12a") still pass, distinct places (branches) stay
  distinct, and a refusal stay out of the miss cache?
