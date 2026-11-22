# Architecture

Client-only: both apps talk directly to the Google Calendar and Google
Tasks REST APIs, and to Apple Reminders and the Apple Calendar app's
calendars through EventKit. There is no server of ours; all state lives
in a local SQLite database per device and reconciles against Google /
EventKit. This document describes how the pieces fit; the hard rules that
came out of it are in `AGENTS.md`, the verified API semantics and the
testing conventions in `docs/google-sync-and-testing.md`.

## Data flow

```
React UI (desktop renderer / iOS)
  │  useAccounts / useCalendars / useEventsInRangeStable / usePendingOps
  │  useTaskLists / useTasksInRangeStable / useNow / useSearch
  │  useBackendMutations()               (packages/app-state/src/hooks.ts)
  ▼
@effect/atom-react atoms                 (packages/app-state/src/atoms.ts)
  │  Atom.runtime(Layer.succeed(AppBackend, client))
  │  reads: Atom.withReactivity([...keys])   writes: runtime.fn({reactivityKeys})
  ▼
BackendClient                            (packages/core/src/backend.ts)
  │  desktop: RpcClient over an Electron IPC frame channel
  │           (duplex protocols: packages/sync/src/rpcDuplex.ts;
  │            server side wired in apps/desktop/electron/backendHost.ts)
  │  iOS:     makeDirectBackendClient — zero-hop, same process
  ▼
AppBackendRpcs handlers                  (packages/sync/src/backendHandlers.ts)
  ▼
EventMutations / repos                   (packages/sync/src/mutations.ts,
  │                                       packages/db/src/*Repo.ts)
  ▼
SQLite (node:sqlite / op-sqlite)
```

**AI** (all on-device, no cloud): prompts, JSON schemas, normalization and
parsing live in `packages/ai` behind the `LanguageModel`, `SpeechToText`
and `TextRecognizer` seams. The Assistant reads a phrase through a
`PhraseReader` (`phraseReader.ts`), on both platforms the tuned path
(`tunedReader`, `tuned.ts`): a Qwen3.5 0.8B trained for these prompts
(`apps/desktop/e2e/bench/train/`), the release both apps fetch named in
`assistantModel.ts` (calendar-models v2). The tuned prompt is the days,
the draft, what was said before (the last six turns) and the words; the answer is the whole draft, a far day, a
ruled-out weekday and a time said as an amount ("+30m" for "half an
hour later", "45m" for "for 45 minutes") written as said and worked out
by code (`said.ts`), and `answerResult` (`tunedResult.ts`) checks shapes
and fills a form's defaults without reading the words. The answer has a
day only where the words gave one: a first phrase without one lands on
the day on show, a later turn keeps the draft's. Each device downloads
the model once, when the person asks for it (the Create lesson's
banner, the Assistant's notice, the Mac's Settings › AI Model; nothing
asks at launch; a new version is offered as an update where an earlier
one was agreed to), checks its size and SHA-256, and loads it on the
first question. The
iPhone fetches over Wi-Fi unless mobile data is allowed
(`apps/ios/src/assistantDownload.ts`, a background `URLSession` in the
`solunivo-model-download` module), runs it with llama.rn and lets it go
when the app leaves the screen (`assistantModel.ts`). The Mac fetches it
into the profile (`apps/desktop/electron/assistantModel/`: `fetch`,
resumed with `Range`) and runs it with the bundled `llama-server` (the
same llama.cpp commit as llama.rn's), started on the first question on
a UNIX socket with a key made for each start, one question at a time,
its memory let go after ten idle minutes; the renderer asks over
`assistant:*` IPC. The draft thread (app-state) does the rest: the
names an answer invites are looked up (`draftInvitees.ts`) through
`contactsNamed` — every contact whose folded words the name begins
(core `nameMatch`), so "one person" is decided over all of them: a name
that is one contact's joins the draft's guests; any other waits on the
draft as a choice until the user picks one, lets it go, or a later turn
says it again; a place the answer changes is looked up among past
places and MapKit (`draftPlaces.ts`, `settlePlace`); a note and
notifications fold into the draft's extras (`draftExtras.ts`) and the
form marks the rows the step changed. A to-do's notifications are its Reminders alerts
(`applyAlarmChange`: minutes before the due time, stored as the form's
negative offsets): a turn is shown the to-do's own, never a calendar's
default, and the alert picker names one the presets lack.

Find a time runs on the same model once it is on the device
(`tunedFinder.ts`, picked by each app's `useFinder`): told the job by
the prompt's first line ("Free time as JSON."), asked without a schema,
its answer the finder's fields the words state, each read only where it
has its type; what it leaves out is the code's default (the coming week,
the finder's own length), and no word rule reads the sentence. Until
then, and for search sentences and capture, Apple's model (or a served
one on the Mac): the model extracts, the code decides. `grounding.ts`
reads those finder's and search's words itself — meal and
part-of-day words, weekdays, windows, bounds and durations — and keeps a
model value only where the words support it. A phrase said to the
Assistant that asks for free time ("find 90 min for focus next week,
mornings", "wann habe ich Zeit für …") is routed by code
(`slotProposals.ts`, `isFinderPhrase`) to the finder prompt instead, a
note or notification said with it read by `extras.ts`; the pure
`findFreeSlots` solver (`packages/core/src/scheduling/`) computes free
slots from the already-synced local events — busy is what `blocksTime`
says (timed, not cancelled, not marked free, not declined), the rule the
agent gateway's free/busy shares — places each gap's slot at the named
part of the day (`preferredTime`) and `rankSlotsAround` orders them by
distance from it. Capture normalizes each item the model found
(`normalizeQuickAdd`, `capture.ts`). Desktop: renderer → preload IPC
(the `model:*` channels: status, info, generate, prepare-speech, the
`speech-*` ones dictation streams over, recognize-text) → main → the
active provider
(`apps/desktop/electron/modelProvider.ts`): by default the Swift helper
child process (`apps/desktop/helper`, Foundation Models, SpeechAnalyzer
and Vision over newline-JSON stdio; spawned lazily and supervised with
restart backoff by `apps/desktop/electron/helperProcess.ts`), or —
picked in Settings › AI Model — a model served over HTTP on this Mac:
Ollama's own API (the JSON schema as `format`, `num_ctx` per call,
`keep_alive`) or any OpenAI-compatible endpoint
(`response_format: json_schema`; LM Studio, llama-server). Only
`generateJson` and `status` have that second home; dictation and text
recognition stay with the helper. `ModelInfo` (`LanguageModel.info`)
says the model's context, and capture sizes its text by it
(`captureTextBudget`). A served model's failure is worded by server
(`modelUnavailableCopy`), and a host that is not loopback gets a notice
in Settings: text pasted into capture leaves the Mac then. The model
bench (`apps/desktop/e2e/bench/`, run by path with `MODEL_BENCH=1 E2E=1`)
runs the Assistant's cases — a phrase and the changes a thread would
make to it, as text or recordings — through the tuned path on any served
model, the app's file on `llama-server` included (its README;
docs/google-sync-and-testing.md → Unit tests). iOS reaches Apple's models via
`@react-native-ai/apple` and Vision through the `solunivo-ocr` Expo
module; why the model cannot run comes from the `solunivo-model-availability`
module (Foundation Models' reason, bounded to 5 s). If that module cannot
load, the package's asynchronous `getModelInfo` supplies the availability
and reason under the same timeout. A stale dev client without that native
API reports a failed check. Both hosts map the reason through `APPLE_REASON_STATUS`
(packages/ai); `LanguageModel.availability` carries it with a failed
check's error beside the status. Every entry point on Apple's model (find
a time, search, the desktop's capture dialog) checks through `useModelAvailability` (app-state): one check at a time (a request while
one is out runs once more after it), a re-check on returning to the app,
a 30 s poll while 'not-ready', and every Check Again answered even when
nothing changed; Settings › Diagnostics (iOS) words it with
`modelAvailabilityCopy.ts` and always asks the device's model, never the
e2e fixture. The Assistant's own model has its own state on both apps
(`AssistantModelState`): while it is not here the conversation shows
`AssistantModelNotice` (the download, its progress, Try Again) and the
editor opens on the Form. Dictation streams each phrase, as it is
recorded, into one speech session (`packages/ai/swift/SpeechBridge.swift`,
symlinked into the helper and the iOS module `solunivo-speech`): on the
desktop the renderer's `getUserMedia` worklet sends 100 ms blocks of
16 kHz Int16 (`model:speech-audio`), on iOS the module records with
AVAudioEngine. Both record through the platform's voice processing
(Chromium's echo cancellation, noise suppression and gain; AVAudioEngine's,
which also lets iOS apply the Mic Mode picked for the app) unless
Settings › Dictation turns it off, a choice kept on the device.
Two recognisers write the words as they are said — DictationTranscriber
("quick", word by word) and SpeechTranscriber ("accurate", in bursts) —
and they come back as `speech.words` events (the module's `onWords`);
finishing reads the phrase once more, whole, with plain
SpeechTranscriber, alternatives kept: each segment of the reading comes
with the readings the recogniser weighed for it (the first is the
segment itself), and the dictated phrase goes to the thread with them
(`Heard`), for the place lookup below. The audio stays in memory and
goes with the phrase. The phrase ends on its words, not its loudness:
`listenForPhrase` (`packages/ai/src/phraseEnd.ts`) ends it when the
quick words have stood still for 900 ms, or, while the accurate ones
are ahead of them, when those have for 1,200 ms; until then the words
show in the thread's pending line (`pendingLine`). Dictation is
hands-free: `useQuickAddModel`
sends each phrase when its words stop and listens again (`voiceLoop.ts`) once
the form has taken the last one in (`useThreadEditor().applying`), until
the microphone is pressed (which sends what was recorded, heard or
not), the field is typed into, the form is edited
by hand (`userEdits`, counted by the setters the forms receive and a
picked free slot, never by a turn's own fills), 30 s pass with nobody
speaking or an older step is put on show.

**Native bridges** (`packages/reminders`, `packages/apple-calendar`,
`packages/contacts`, `packages/geo`): each is one JSON protocol spoken by
one Swift source, symlinked into the desktop helper (`callHelper('x.*')`
over stdio) and into a local Expo module (`apps/ios/modules/solunivo-*`).
What each holds and where its data lives is AGENTS.md's map; the passes
and the read-through are under Sync engine and Apple Calendar, below.
Writes go to EventKit first and mirror the result (no pending op —
EventKit is local and synchronous). The permission asks are
window-level concerns (`reminders:status` / `contacts:status` /
`appleCalendar:status` preload IPC on desktop, the On This iPhone page on
iOS); rows only ever cross the rpc seam.

**Invalidation path** (backend → UI): repo mutations invalidate Reactivity
keys (`packages/db/src/keys.ts`: `accounts`, `calendars`, `events` and
`events:<calendarId>`, `pendingOps`, `tasks`, `taskLists`, `contacts`,
`birthdays`, `locationGeo`, `syncState`, `deviceSettings:<key>`, plus
`notice:dropped` as a broadcast-only signal). `forwardingReactivity`
(`packages/db/src/reactivityForward.ts`) decorates the backend Reactivity
to also publish every key to an in-process invalidation bus; the bus feeds
the `stream: true` `invalidations` rpc, and `bindInvalidations` (atoms.ts)
replays keys into the UI runtime's Reactivity. A change written by the
sync engine in the Electron main process repaints React in the renderer
with no polling.

## Pending-op queue (offline-tolerant writes)

Every Google mutation writes SQLite optimistically, then enqueues a
`PendingOp` and kicks `processPendingOps` (semaphore-serialized, drains
due ops oldest-first). Kinds:

| kind            | eventId                       | payload/fields                   | remote call                                                                                                                       |
| --------------- | ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `create`        | client-generated id           | full EventRecord                 | events.insert (idempotent — 409 = already landed); attendees included; `sendUpdates=all` when guests exist                        |
| `update`        | event id / instance id        | EventRecord + `attendeesChanged` | events.patch (If-Match when etag known); attendees only when flagged; `sendUpdates=all` when guests exist or the list was edited  |
| `delete`        | event id / instance id        | EventRecord (the deleted row)    | events.delete (If-Match when etag known); the payload ties an exception's delete to its series                                    |
| `rsvp`          | event id                      | EventRecord (attendees)          | events.patch, attendees-only body: Google's guests with the answer over them; If-Match, resent **without** on a 412 (never parks) |
| `calendarColor` | `__calendar_color__` sentinel | `colorHex`                       | calendarList.patch?colorRgbFormat=true                                                                                            |
| `move`          | master id (source calendar)   | `targetCalendarId`               | events.move?destination= (same account; organizer only; whole series)                                                             |
| `createTask`    | temp `local-…` id             | title/notes/due                  | tasks.insert (NOT idempotent — see below)                                                                                         |
| `updateTask`    | task id                       | title/notes/due                  | tasks.patch                                                                                                                       |
| `completeTask`  | task id                       | completed flag                   | tasks.patch (status; `completed: null` when un-completing)                                                                        |
| `deleteTask`    | task id                       | —                                | tasks.delete (404/410 = already gone)                                                                                             |
| `moveTask`      | task id                       | `targetTaskListId`               | tasks.move?destinationTasklist= (same account; subtasks follow)                                                                   |
| `reorderTask`   | task id                       | `taskParent` / `taskPrevious`    | tasks.move (same list), then the list's order is read back                                                                        |

`PendingOpSummary` in core/backend.ts has its **own kind literal** — extend
it whenever a kind is added. Rules that keep the queue correct:

- **Coalescing**: a content edit removes prior ops for the same
  (accountId, calendarId, eventId) — a shared calendar repeats its ids
  under every account — and re-enqueues (a never-sent `create` absorbs
  edits; a sent one, stamped `dispatched_at` before the insert, stays
  ahead and the edit follows it); `removeForEvent` deliberately spares
  `rsvp` and `move` ops; `calendarColor` ops coalesce **per account**
  under the sentinel. A task edit folds into an undispatched `createTask`
  and queues as `updateTask` behind a dispatched one; task updates merge
  field by field, one patch per task. Every coalesce-then-enqueue runs in
  one transaction with the drain kicked after commit (`transactional`).
- **Backoff**: transient failures retry at `30s·2^attempts`, capped at
  30 min (`retryDelayMs`); non-409 4xx (except 429) and an undecodable
  2xx are permanent → `drop`, which releases the row and broadcasts
  `notice:dropped`. A sync the user caused (`SyncEngine.syncNow`: the
  app came back, the machine woke, an account reconnected) makes waiting
  ops due at once (`retryNow`); the timed poll keeps the backoff.
- **Acks** (`settle`, one transaction with the queue check): a response is
  written to its row only while no later op of the event is queued — that
  op owns the row and its own response settles it. An `update` that lands
  moves the ops queued after it on the etag it was sent with, and the row
  a later edit still holds, to the etag it produced (`advanceBaseEtag`,
  `advanceEtag`): a second drag made while the first was in flight follows
  it instead of meeting a 412. Only an If-Match write does this — Google
  checked that etag, so nothing else changed in between; an `rsvp` does it
  when its If-Match held, one resent unchecked after a 412 moves nothing.
  An op queued _before_ the one that landed (in backoff while it overtook)
  keeps its etag and meets its 412. A create answered 409 fetches what
  Google has, so the row stops being `pending`. A `delete` answered 404
  or 410 is done like one that landed (`dropPulledCopy`): an occurrence's
  cancelled override stays, a synced copy at its id goes. A create dropped
  for good or discarded takes what was queued behind it on the event
  along, putting nothing back — an edit, an answer, a delete (built on an
  event Google may never have had, a delete discarded later restored it
  as one), a move with the rows it already put at its destination, and
  what followed that move there, a further move's destination in turn.
  One the create landed after all comes back with the next pull; one that
  landed with an answer that did not decode keeps them.
- **Conflicts** (only `update` and `delete` park). Google's newer
  version of an event a queued change holds arrives two ways: in a pull's
  page, or fetched (`events.get`; 404/410 = deleted there) after a write
  was refused with 412. Either way it becomes the event's copy (see
  "Google's copy of a held item" below) and the queued changes are laid
  over it again (`heldEvents.ts`): an update keeps the fields it changed
  against the old copy and takes Google's in every other (`rebaseOnto`),
  an RSVP lays its answers over Google's guests (and an edit queued after
  it keeps them; what it sends is the copy's guest list with those
  answers, never the row's, which may show a guest-list edit still
  queued or parked), an edit made on the very version that arrives is left
  as it is — a full list names every event, changed or not, and one the
  user kept, sent without If-Match, counts as made on the copy — and the
  row shows the result, still `pending`. A thing the user changed part of
  stays the user's whole (a time's start with its end): mixed with
  Google's other half it is a time nobody chose. The reply to a write sent without
  If-Match (an answer resent after its 412, keep-mine) may hold another
  device's change too, and is taken the same way by the ops still queued
  (`take`); so is a move's answer by what is queued behind the move when
  the event changed meanwhile, and the record that settles a create by
  what is queued behind it. Advanced to such a reply as it stood, the
  copy made the fields that device changed read as the user's own, and
  the next write sent the old values back. Nobody is asked unless both sides changed the
  same thing to different values — a time (start, end, all-day and zone
  are one thing), a place (its text and its coordinates), or any other
  field — or the update edits the guest list and Google's version moved
  without already holding that edit: Google replaces the whole list,
  guest fields we do not keep included. Then the op is **parked**
  (`markConflict` sets `conflict_at`), never dropped, with the user's
  version on screen. A delete parks whenever the version it names
  (`base_etag`) is Google's no more: it takes along what we do not keep
  at all (attachments, a color), so no comparison of the fields we keep
  can say nothing changed. That includes our own series PATCH, which
  gives every exception a new etag (verified live): an occurrence
  deleted after it and before the next pull asks. One the user kept (no
  If-Match) goes whatever Google has. After a 412 three more outcomes:
  Google's copy already yields exactly the PATCH body the update would
  send (`updateBody`: our own earlier attempt landed with its answer
  lost), which is done; an update laid over Google's version without a
  clash goes again at once on Google's etag, and a second 412 there is a
  newer change still and meets the same check; a failed fetch is an
  ordinary retry. A series PATCH that changed text lands that text on
  its exceptions too (`advanceCarried` folds it into their copies, and
  into the payload of an edit queued before the series edit, or of one
  queued after it in the fields it did not change itself, which would
  put the old text back otherwise). `listDue` skips parked ops. The UI
  reads the conflict from `listPendingOps` (`PendingOpSummary.conflict`:
  mine is the op's payload, theirs the event's copy, `null` when Google
  has the event no more) — a persistent banner on both apps plus the
  queue rows — and `resolveConflict` settles it: **mine** unparks with
  `base_etag` cleared so the re-send overwrites Google (an edit of an
  event Google deleted is re-created under a new id as a standalone
  event); **theirs** re-fetches Google's _current_ copy and writes it in
  ack mode, then drops the op — a series delete's exceptions come back
  with a live master, and a series gone on Google takes its synced
  exceptions along. Take-theirs is refused while a move of the series is
  queued ahead. A new edit or delete of a parked event replaces the
  parked change and stays parked (`inheritedPark`): the row carries
  Google's etag by then, and sent on it the new change would overwrite,
  unasked, what the two clashed over.
- **401**: the op stays queued, the account is flagged `reauth_required`;
  reconnecting (same account id, resolved by email) resets status and the
  queue drains at once.
- **Provider dispatch**: `completeTask/createTask/deleteTask/updateTask`
  look up the account's provider. Google lists take the queue; Apple lists
  call EventKit synchronously via `reminderMutations` and write the result
  through (`upsertTasks`), so a created reminder has its real id from the
  start. Reminders-only fields (time, priority, url, alarms, recurrence,
  `moveToListId`) on a Google list fail with `UnsupportedForProviderError`.
  `updateTask` takes a due day away with `dueDate: null`: a Google op
  carries `taskDue: null` (stored as `task_due_cleared`, pushed as
  `due: null`; folded into an unsent create, the create goes undated), a
  reminder loses the day and its time in EventKit. A repeating reminder
  keeps its day unless the rule goes too — EventKit refuses one without
  — so the editor drops the rule with the day and hides Repeat while a
  reminder is undated.
  A Google `deleteTask` takes the task's subtasks first, each a delete of
  its own, since Google deletes them with their parent: discarding a
  subtask's delete discards its parent's too, and the parent's delete,
  once it lands or finds the task gone, settles any subtask delete still
  waiting on a retry. `previewDeleteTask` counts them for the editor's
  question.
- **Task moves** (`moveTask`, the task twin of `moveEvent`): between two
  Reminders lists EventKit changes the list in place, and so does Google
  inside one account — a `moveTask` op (`tasks.move` with
  `destinationTasklist`) keeps the id, takes the subtasks along nested as
  they were, and the task leaves a parent it had. The form's edits are
  queued first; the rows move at once and every op queued for the task or
  its subtasks is re-queued in the destination behind the move (an
  earlier move out of that list stays where it is, and so it does when
  the task is deleted there). An op
  addressing a list a queued move goes into (a move onwards included)
  waits for it, a move waits for what was queued before it in its
  source list (`earlierTaskOps`), and a delete for a move out of its list
  queued before it: Google deletes a parent's subtasks with it, one the
  user moved out first included. While a move waits, a pull of the source
  does not put its rows back (Google sends no tombstone when a task leaves
  a list): a Google list's pull holds the drain (`whileQueueHeld`), so no
  move lands while its request is out, and reads the queued moves after
  each answer; a copy that slipped in anyway goes when the move lands. A create still
  in flight refuses the move (`TaskCreatePendingError`); an unsent one is
  simply created in the destination. A discard or a 404 puts the rows
  back, with what was queued behind the move (a subtask deleted since
  included; what was queued before it — an earlier move out of the
  destination — stays, so a discard releases the move while it is still
  queued; the task's next move out of the destination ends what goes
  back: onwards, it now leaves from the source; a move back to the source
  — the task's or a subtask's — goes, having nothing left to move, and
  the row is Google's there again, under the parent Google has it under)
  — unless the 404 answers a retry whose first attempt landed:
  then the task is in the destination already and the move settles
  there; a destination Google does not answer for keeps the move queued,
  and one that is gone puts it back. A discard of a move that was sent
  asks Google first, as an event move's does (`settleDiscardedMove`):
  one that landed with its answer lost settles in the destination. A
  task whose delete is still queued has no row, and a pull writes none
  (below); an edit or a toggle of it is refused (`TaskNotFoundError`).
  Open: a subtask's parent deleted with it keeps its own delete queued,
  which still takes the subtask along on Google.
  Mirrors count a queued move for both lists. Every other route —
  Reminders ↔ Google, another Google account — creates the task in the
  target from the editor's draft, then its subtasks (nested under the
  copy on Google, `createTask` with `taskParent`, last to first since
  Google inserts a subtask first among its siblings, each waiting for the
  one before it so a retry cannot swap them; as reminders of their
  own in Reminders), and then deletes the source, subtasks first; a
  failure in between leaves a duplicate, never a lost task (toward
  Google the source outlasts its queued copy, `PendingOp.copySource`). Completion
  follows. What a route drops — reminder fields, a subtask leaving its
  parent, subtasks Reminders cannot nest — is `previewMoveTask` (core
  `taskMoveLoss` over the stored record and its subtasks), confirmed in
  the editor before anything is written. `parentId`/`position` are stored
  for Google tasks. The task inbox on both apps nests each section with
  core `nestSubtasks`: a subtask under its parent when both are in that
  section (after the iOS list filter), siblings in `position` order; a
  subtask whose parent is elsewhere stays a row of its own.
- **Reorders** (`reorderTask`): a Google task's place inside its list —
  under a parent (or none) right after a sibling (or first) — is
  `tasks.move` with `parent`/`previous`. The row takes the new parent and
  a provisional `position` at once (core `provisionalPosition`: a key
  strictly between its new neighbours'; Google's are 20-digit ordinals,
  a provisional one may add digits or a `-`, and positions compare code
  unit by code unit), while Google's copy of the task keeps its place
  there (`task_copies`).
  One level deep, as Google Tasks draws it (the API takes any depth): a
  task with subtasks never goes under another, nor a task under a
  subtask (`TaskHierarchyError`). A task Google has not created yet is
  neither placed nor a parent (`TaskCreatePendingError`); a previous
  sibling it has not created puts the task after the last one it has.
  Reorders are never coalesced — each names its neighbours as the ones
  queued before it left the list — so a reorder waits for every task op
  queued before it in its list, and a delete queued behind one waits for
  it. Google renumbers the siblings on every move and bumps no `updated`,
  not even the moved task's, so no `updatedMin` pull brings the new order
  (the next pass reads it, see Tasks below): once a reorder lands the
  drain reads the list's order back at once (`taskOrder.ts`) onto every
  row of the list (`refreshHierarchy`; a queued edit or toggle does not
  touch the order) and replays the reorders still queued over it in queue
  order, as Google will apply them — each one's place before it becomes
  what its discard puts back; a queued delete takes Google's place too. A discard or a refusal (400 for a sibling that is
  no longer one, 404) puts the row back where Google has it, or where an
  earlier reorder still queued puts it; a reorder queued behind it takes
  that place over (a task's reorders are stamped strictly in order). A
  task put back under a parent whose delete is queued keeps that parent:
  the delete goes, as when a subtask's delete is discarded. As a reorder
  is sent the one-level rule is checked again (an undone change can make
  it nest two deep, which Google accepts): one that would is dropped. A
  move to another list waits until no reorder involving the task or its
  subtasks is queued, and a reorder until no move of the task, its
  parent or the tasks it is placed by is (`TaskCreatePendingError`):
  which rows a move carries is not settled before Google has them.
  Reminders have no order or subtasks
  through EventKit (`UnsupportedForProviderError`). Both apps place a row
  through core `taskDropAt` over the section as drawn
  (`flattenTaskTree`): depth 1 puts it under the group above the gap,
  after the row above; depth 0 takes a subtask out, right after its
  parent. Top-level rows keep the section's own order (day, then title),
  and a drop never leaves its section: a section is a date bucket of
  several lists and providers, whose positions do not compare. The
  desktop rail drags a row within its section (a line marks the gap,
  half an indent sideways nests or un-nests; out of the rail it still
  drops onto the grid) and indents or outdents a focused row with ⌘] and
  ⌘[ (`indentTaskDrop`/`outdentTaskDrop`), as Reminders does; the iOS
  Tasks tab swipes a row right for Indent or Outdent, which VoiceOver
  offers too.
- **Conversions** (`convertEventToTask`, `convertTaskToEvent`): an event
  becomes a task or a task an event by creating the other kind from the
  editor's draft and then deleting the source — the same copy-then-delete
  as a cross-provider move, through the shared `crossStore` ordering
  (toward Apple the EventKit create first, then the queued delete; toward
  Google the source outlasts its queued copy — see moving between
  calendars). A recurring event converts as its whole series
  or, when the call names an `occurrence` by its slot, as that occurrence
  alone: the delete is then the instance delete "This event" runs, so the
  series skips the slot and keeps its rule and its other occurrences. The
  editors carry the fields across (core `editor/convert.ts`) and ask only
  when a set field has no home on the other side (`convertLoss.ts`;
  `previewEventToTask` computes the event side from the stored record and
  carries the series' rule, since an occurrence row never has its
  master's lines — for one occurrence it reads that occurrence instead
  (Google: its own row where it was edited on its own, else the master at
  its slot; Apple: EventKit's copy of it) and carries no rule;
  `previewTaskToEvent` reads the stored task and counts the subtasks its
  delete takes). The views offer
  Convert on a series at "This event" and "All events", never at "This
  and following" (`seriesConvertsAt`); the task form takes over what the
  event form's scope stands for at each flip and keeps that scope, and
  Save names the source by it (`convertSourceOf`), whatever the event
  form's scope is by then.
- **Task creates are not idempotent**: Google assigns task ids
  server-side, so a `createTask` writes a temp `local-…` row that is
  swapped for the server task on success (`rewriteEventId` renames the
  queued op; the row is remove+upsert, never an id UPDATE — a concurrent
  pull may already have inserted the server row). Before retrying a
  `createTask` that was already dispatched, the drain first lists the
  tasks changed since — every page — and adopts an exact match; otherwise
  a crash between insert and ack would duplicate the task. The stamp is
  set only while the op is still queued, in one transaction with that
  check. Task ops still carrying a temp id wait in `applyOp` until the
  create swaps it — a delete among them: deleting a task whose create was
  sent keeps that create (it may have landed), and the retry then only
  looks for what landed, for the delete to take — only a task Google
  made open within two minutes of the stamp that no row here holds, never
  the user's own twin — and the swap to Google's id is one transaction; a create that will not land takes the ops waiting on its
  temp id with it.
- **Moves keep queue order**: `listDue` skips ops in backoff, so a move
  and the edits of its series (`<masterId>` and `<masterId>_<basetime>`
  instance ids, any calendar of the account) check `earlierInSeries`
  first — a move waits for older edits, an edit waits for an older move,
  and occurrence edits and RSVPs wait for a create queued ahead in their
  series, and an occurrence's op for every change of its series queued
  ahead of it — it was made under that change: new times give the
  occurrence another id on Google, changed text is copied onto every
  exception over an occurrence's own that got there first, and a new
  rule's landing forgets the exceptions it drops (`dropsFrom`), so an
  exception made under it must land after it, also when its answer was
  lost and a backoff let the occurrence's op go first — and an
  exception's delete for one that drops its slot wherever it sits (a
  series edit that replaced the change went to the back of the queue, and
  the deletes went out ahead of it, past taking back), and the create of
  a series a this-and-following edit split off for the cut of the one it
  came from (see Recurring events).
  `moveEvent` re-queues pending edits of the series _behind_ the
  move, re-keyed to the destination (a never-sent create simply becomes a
  create there; a sent one stays in the source with the move behind it; a
  delete of the moved event is dropped instead, see Sync engine; an
  earlier move out of the source — the event left and came back — stays
  where it is and goes first). A re-queued edit goes without If-Match.
  One made while the move waits keeps the row's etag, and when the move
  lands with nothing else changed on Google (`onlyMoved`: no op parked,
  the event's copy equal to what the move answered with) the ops behind
  it and the
  row move to the etag it produced (`advancePastMove`): events.move gives
  the event a new one, and the old one met a 412 and parked a conflict
  nobody caused. With another change on Google they keep it and meet that
  conflict; a move Google never makes leaves them theirs, still Google's
  in the source.
  A move's 404 (or 410) first asks the destination for the event: an
  earlier attempt may have landed with its answer lost, and found there
  the move settles as landed (a lookup with no answer retries); a 2xx
  whose body did not decode landed too. A move Google never makes —
  discarded, refused (a 403 for a non-organizer, any other permanent
  4xx), or not in the destination either — puts the rows back in the
  source with what was queued after it, the event's copy re-keyed the
  same way and the ops rewritten in place, so each keeps its place in
  the queue
  (`releaseMove`, `retarget`). A discard releases the move before
  removing it, so its place is known. One never sent goes at once (the
  drain stamps a move `dispatched_at` in one transaction with checking
  it is still queued); one that was sent may have been made, so under
  the drain's gate it asks the destination first, as a 404 does, and
  with no answer goes back as the user asked. Left in the
  destination, an edit or a
  this-and-following cut's master update and exception deletes would
  404 there and be dropped, while the source row showed what Google
  never got. The series' next move out of the destination ends what goes
  back: it now leaves from the source (a move back to the source has
  nothing left to move and goes), and it took the rows along, so rows
  and ops in the destination behind it belong to a later move back in. A
  row a queued op owns stays as it was, and every row stays while a move
  into the source is queued (it settles them); the rest are handed to
  sync. Ties on `created_at` break by `rowid`.
- The drain loop re-reads each op by id before dispatching: a missing row
  means the user discarded it (skip), and coalescing rewrites stay
  visible. Each failure is recorded in `last_error`; the unsynced-changes
  list shows it as the row's reason.
- **Google's copy of a held item** (`event_copies`, `task_copies`).
  While a queued change holds an event or a task, its row shows the
  user's version and Google's lives beside it: once per item, whatever
  the number of changes queued for it, keyed where Google has the item
  (a task's source list until its move lands; a move re-keys an event's
  to the destination with its ops, and back if Google never makes the
  move), and gone again once nothing queued holds the item
  (`dropIdleCopies`, `heldTasks.refresh`). A queued update or answer of
  an event keeps only what it changed against that copy (`pending_ops.
  changes`, `EventChanges`: the fields the user set or emptied, a time
  and a place whole, the answers that differ, the guest list when it was
  edited). Its version of the event, `PendingOp.payload`, is not stored:
  it is the copy with those changes over it, computed at every read, so
  when the copy moves on the rest of the event moves with it and no path
  can leave an old value in a waiting change to be sent as the user's.
  The PATCH names only what differs from the copy too (`changedBody`),
  and a field the user did not change is never written from this device.
  An occurrence Google has no exception for has no copy, and keeps the
  version it was queued with. It is written when the first
  change is queued (the synced row, `enqueue`, `TaskRepo.holdTasks`), by
  every pull and conflict fetch (Conflicts above; Sync engine), and by
  answers: when an op lands while others of the item wait, the copy
  becomes what Google acknowledged (`advanceBefore`, `heldTasks.land`),
  so discarding one of them never undoes it. Every queued op of an event
  reads the copy as `beforePayload`; `null` means Google has none — an
  occurrence edit or delete that materialized its override, an event a
  pull or a fetch found deleted, an exception a landed rule dropped
  (`forgetDropped`) or whose series is gone (`forgetSeries`). A queued
  delete of a series also holds the copies of the exceptions it took off
  the table with the master, which queue no op of their own
  (`beforeOverrides`, read from the same table; one whose own delete
  waits is that delete's). Not copies: `beforeColorHex`, a calendar's
  previous color, and `carriedText`, the exceptions' own text under a
  queued series edit that mirrored its text onto their rows.
  The unsynced-changes list diffs an op against the copy
  (`pendingOpDiff`, computed in `listPendingOps` as display lines), and
  an abandoned op puts it back (`releaseRow`): a discard, a permanent
  rejection and keep-mine with nothing left. With nothing else queued
  for the event the row is the copy again, whole and synced — Google's
  version as it is now, another device's change included, not the one
  the edit started from. While another op still holds the event only the
  fields this op owns go back (an RSVP the answers it changed; an edit
  the fields it changed, the guest list only when it edited it), out of
  the row and out of what the other queued ops send, and the row stays
  `pending`. An op with no copy (`null`) removes the row it made. A task's
  row is rebuilt rather than patched: the copy with the queued edits and
  toggles over it (`heldTasks.refresh`; with nothing left queued it is
  the copy, in Google's list alone — a row a move of its parent took
  elsewhere goes), shown where its queued moves and reorders leave it (`placeOf`: a move of its own takes it out of its
  parent, a move of its parent takes it along; `revertTaskMove`,
  `revertTaskReorder`). A delete's discard re-inserts the copy, and a
  series delete's the exceptions it holds, each only where no row is (an
  occurrence edit or delete made since is newer, and a landed occurrence
  delete leaves its tombstone, Google's then) with a waiting answer laid
  over it (`putBack`), and with them what its occurrences' own deletes
  took (`restoreDropped`); an exception whose series delete waits with
  the master gone becomes a copy that delete holds instead of a row
  (`takeIntoDelete`). A color goes back only while the calendar still
  shows the op's own (calendar-list pulls do not skip a queued color).
  An op replaced while its request was in flight puts nothing back when
  that request is refused — the replacement owns the row. A 2xx whose
  body did not decode (the write landed) keeps the row's content. Known
  gap: a full re-list after an expired sync token confirms a deletion
  only by absence, which removes no copy. Open gaps of repeating events,
  each a skipped test in `queueSequence.test.ts` and a seed in its
  `KNOWN_FAILING`: an edit of all events replaces the series' queued
  change and goes to the back of the queue, behind a change of one
  occurrence made under it (several changes of one event queued in order
  would close it; what a change stores allows that now, the queue does
  not do it yet); an occurrence changed under a new rule that is then given up keeps
  its change at a slot the series no longer draws; the deletes a rule
  change queued outlive a delete that replaces it; and a change that had
  landed with its answer lost, discarded before a pull says so, is put
  back as if Google never got it.

Rules a change to the queue keeps (each broke once):

- Ops of one item are not all ordered: the drain does not hold an
  occurrence delete behind its series delete, so "the occurrence delete
  landed first" is an order to handle and to test.
- A 404 on a retried write can mean the first attempt landed and its
  answer was lost: check where it would have landed (as a move does,
  `settleOrRevertTaskMove` for tasks), never read it as "never made".
- Work done when an op lands runs on every landing path (a 2xx, the
  412 match in `park`, a 2xx whose body did not decode) and never
  overtakes ops queued after it, which a lost answer lets land first. A
  new `pending_ops` column gets a backfill for the ops queued before the
  upgrade.
- An op the user undid never stays queued across a wait for the drain's
  gate: the undo takes it out in its own transaction and the drain
  decides (a discarded cut, left queued, was sent by a drain already
  waiting). The one exception is a move that was already sent: it stays
  queued until `settleDiscardedMove` settles it under the gate.
- A fix to one queue path checks every producer of the op it touches,
  a reviewer's included: cuts and rule changes both produce
  `dropOverridesFrom`, and a fallback keyed on it broke rule changes.
- What a queued op holds, rewritten per record inside a page's
  transaction, is quadratic (1,000 exceptions took 1.9 s; batched, 20
  ms): a page's exceptions go to their series' delete in one write per
  series (`holdPulledExceptions`), and only held items are laid over
  Google's copy again.
- A change of how a queued change is stored is judged by the seeded
  sequences (`QUEUE_SEQUENCE_RUNS=1000`), not by the unit suites alone:
  they found every gap listed above, and what closed them.

## Sync engine (packages/sync/src/engine.ts)

- Poll every 90 s (`SyncInterval`, a `Context.Reference`) plus kicks on
  wake/unlock/window-focus (desktop `powerMonitor`) and `AppState` active
  (iOS), throttled to one per 15 s (`syncKicker.ts`).
- `syncAll` is semaphore-serialized and always **pushes pending ops before
  pulling**, which keeps conflicts few; a pull never overwrites a pending
  row whatever the order (below). A calendar's color has no such guard,
  so the `calendarColor` apply upserts the patch response.
- Events sync the **whole history**: a full pass (first sync of a
  calendar, or a 410 resync) lists the calendar with no `timeMin`, and the
  sync token it returns then covers every event ever. A token is bound to
  the query it was issued for — a windowed one could never be widened, so
  a token must always come from an unbounded list. Nothing prunes by age;
  `deleteStale` only removes rows a completed full pass did not touch. The
  pass writes its `sync_state` row `'syncing'` until the list completes
  (`'error'` on failure, token kept for a failed incremental pass), and
  `listSyncStatus` turns that plus a row count into the Settings
  "Importing history…" line.
- A full list of a big calendar is many 2,500-event pages: each page is
  one transaction (`EventRepo.applyPage`) with one invalidation, and the
  engine yields between pages so rpc handlers and the UI interleave. An
  empty pull page invalidates nothing. Calendars that vanish upstream
  take their event rows and their events sync state with them in one
  transaction (`CalendarRepo.purge`), and a calendar new to the local
  list has any leftover scope cleared before its first pass — so a
  calendar that comes back always re-lists its history. A 404 from one
  calendar's `events.list` skips that calendar for the pass and drops the
  calendarList token so the next pass lists calendars in full (a 404 is
  no proof of deletion); a 404 from one list's `tasks.list` skips that
  list the same way.
- With every master ever synced in the table, `getWindow` bounds the
  recurring-masters query by a stored `recurrence_end_utc` (a plain UNTIL,
  or the last occurrence — COUNT and RDATE values included — computed
  once at write time; NULL = endless) over a partial index, so ended
  series are never expanded again. Expansion runs under an iteration cap
  and `assembleWindow` skips a master whose rule throws instead of
  blanking the window.
- **Pulls and held items.** Incremental pulls use syncTokens; a 410
  forces a full resync, after which `deleteStale` purges rows the server
  no longer returns (pending rows are protected by sync_status). A page's
  deletions are not: `applyPage` deletes by id whatever the row's status,
  so a pending row with no op for an event Google deleted lasts only
  until the next pull. Local writes mark their row `pending`, and a pull
  never overwrites one (`mode: 'pull'`): what Google sends for an item a
  queued change holds goes to the item's copy instead, and the queued
  changes are laid over it again in the page's transaction. For an event
  that is `heldEvents.receive` — an edit of other fields shows beside
  another device's change at once, and one that clashes with it is
  parked there, not at its next 412 (Pending-op queue, Conflicts). For a
  task it is `TaskRepo.updateCopies` and `heldTasks.refresh`: the row is
  Google's newer copy with the queued edits and toggles over it. So an op
  abandoned later puts back what Google has now, never the version the
  change started from. The push response (ack upsert), an abandoned op
  (`releaseRow`) or a resolved conflict hands the row back to sync.
- **A page can be the answer a write lost.** The event a queued create
  inserts, or an event in the calendar its next queued move takes it to,
  can only be in a page because that write landed: it is settled with
  the page's record as its answer and leaves the queue, right after the
  page's transaction and still under the pass's hold on the drain
  (`landedInPull`, `acknowledge`; such a record is the move's answer and
  is not taken by what waits behind the move first — the move knows the
  new etag for its own, and a delete made in the destination would park
  on it). Left queued, a discard took back what
  Google has — the created row, or the event back to a calendar Google
  no longer has it in — for good, the token having moved past. Only an
  event's first queued move is read this way: a page tells of Google
  before that move or after it, never of one queued behind it. The
  source's side of a move: a page that reports the event gone from the
  calendar its next move takes it out of (or a full list that no longer
  names it, for a move queued before that pass began) marks the move
  (`PendingOp.sourceGone`), since the move
  landed or another device deleted the event. A move Google then turns
  out never to have made (a 404 in both calendars, a discard) puts
  nothing back there, and a move of it out of the same calendar queued
  behind takes the mark on. And a page that reports an event gone from a
  calendar a queued move brings it back to tells of the earlier move
  out: the rows there are that move's, and stay. What a page brings for
  an event (or the exceptions of a series) a queued move takes out of the
  page's calendar is not written there — Google lists it there until the
  move lands, and it showed in both calendars — but to its rows where
  they are, in the calendar its last queued move takes it to, re-keyed
  (`showMoving`): a row only the move holds takes it and stays pending.
  And when a page settles a series' move, the page's records of that
  series' exceptions are applied again, since their rows were the move's
  when the page went in.
- **A queued delete leaves no row, and a pull writes none**: Google's
  copy of an event or a task whose delete waits goes to its copy (a
  delete of an event that changed since parks), also when the delete
  waits behind the event's own create, whose landing the page proves. A deletion a page
  reports removes the copy: the sync token has seen it and will never
  send it again, so nothing is left to put back (`forgetDeleted`,
  `heldTasks.forgetDeleted`; the copy of a task whose queued move shows
  it in that list too — the move landed with its answer lost — and the
  row shown elsewhere). A task Google still lists in another list than
  the one its delete names is not written there either. A delete that
  lands or finds the item gone removes a synced copy still at its id (a
  live event row, never a cancelled override — an occurrence whose slot
  its master's rule still draws becomes the cancelled tombstone Google
  now has, or the slot would show until a pull, and an occurrence
  delete's own pending tombstone is Google's too once no other op owns
  it; a task row only while no op owns it), and a series delete also the
  synced rows of its exceptions (`dropSeriesExceptions`).
- **While a series delete waits, Google's copies of its exceptions are
  copies that delete holds** (`takenExceptions.ts`), not rows: without
  their master they would show as events of their own. A pull's copy of
  one (where no row sits at its id) or an answer's ack of one goes there,
  and so does one a discard of a cut's delete of it, keep-theirs on that
  delete, or an occurrence edit undone after keep-mine would write back
  (`takeIntoDelete`; such an undone edit only once no op but an answer
  owns the row). An exception's own queued delete (a cut's) reads the
  same copy. A discard of the series delete puts them back with the
  master, where no row is, a waiting answer laid over Google's copy
  (`putBack`). A page that reports the series deleted on Google forgets
  them, as the delete's landing would.
- **A this-and-following cut, or a rule change, takes the exceptions it
  drops off the table** and queues a delete of each behind its master
  update (`dropOverridesFrom`; a rule
  change drops only those whose slots the new rule no longer draws —
  Google keeps the others as they are, verified live — and first takes
  back the deletes an earlier cut or rule change queued for slots it
  draws again, putting their copies back as Google's: `takeBackDropped`),
  which outlives a later series
  delete (it finds no row to take); what that delete puts back is
  Google's copy of the exception. An occurrence the user deleted keeps its own delete and pending
  tombstone instead, queued behind the change like the change's own and
  unparked (ahead, it went out first, and keep-theirs on its 412 showed
  the occurrence past the cut; abandoned, the change leaves it to meet
  that 412 again). While the change waits, a pull's live copy of such an
  exception becomes the copy its delete holds, where no row is
  (`holdPulledExceptions`): on the table it showed past the cut on its
  own, or over the new rule. The deletes go with the change that queued
  them: abandoned — a discard, a rejection for good or keep-theirs of the
  cut's or rule change's update (from its `dropsFrom` on), or of a series
  delete that replaced it — the series is back as Google has it, and each
  delete of one of its exceptions goes but an occurrence delete the user
  made, whose payload is the tombstone it wrote (`dropChangeDeletes`,
  after `restoreDropped` below put its copy back; a tombstone keep-mine
  left gives way to that copy, and a copy an answer waits on shows that
  answer again, pending); left, they still cancelled those occurrences
  on Google. The new series of a this-and-following edit goes the same
  way where Google still has the series uncut (`splitSeries.ts`, see
  Recurring events). Keep-mine on
  such a delete while the master on the table draws its slot leaves the
  delete's own tombstone there, pending (`takeBackPulled`): with the copy
  gone, the slot showed until a pull. Wherever Google's master is back on
  the table — a pull wrote it,
  a discard of the series delete or of the cut's (or rule change's)
  master update gave Google's rule back, or keep-theirs took Google's
  master — those copies go back too, synced, where no row is
  (`restoreDropped`), for each delete still queued (a pull's case) to
  take when it lands; only where
  the master's rule draws the slot, and only until the cut or the new rule
  reaches Google. That series update carries where its drop starts
  (`dropsFrom`: the cut's occurrence, 0 for a new rule — Google cancels
  the exceptions whose slots the rule it lands no longer draws; an update
  replacing it keeps the earlier,
  and drops nothing more once one it replaced in flight landed the same
  rule),
  and however it lands (a 2xx, a lost answer a 412 finds on Google)
  everything that still holds one of those exceptions — one the landed
  rule does not draw — forgets it (`forgetDropped`): its copy goes, so
  the occurrence's queued ops have nothing to put back (an edit that
  replaced a cut's delete included) and a waiting series delete holds it
  no more, a synced row (Google's copy a discard or keep-theirs put
  back, a landed delete's tombstone) goes,
  and the delete the cut or rule change queued for it goes unsent: Google
  cancelled it with the PATCH and gave it a new etag, so the delete's
  If-Match would meet a 412 and park (an occurrence delete the user made
  owns its pending tombstone: one made before the change is done too, its
  tombstone Google's; one under a later queued rule that draws the slot
  again still goes); otherwise a later rule drawing their slots (more
  days, say) showed them over it, where Google draws plain occurrences. A page that reports the
  series deleted forgets them too, as it does a series delete's
  (`dropSeriesExceptions`), or a discard of one would write it back
  without its master. A copy put back at a waiting delete's id is
  Google's, synced, with Google's answers, which a waiting answer's ack
  then replaces. Off the
  table, a moved occurrence showed at its slot, a cancelled one came
  back, and an occurrence edit was built on the slot.
- **Acting on Google's copy at a waiting delete's id replaces that
  delete.** Such a row is an exception put back as Google's while a
  delete of it still waits (a cut's or a rule change's, `restoreDropped`;
  a pull writes none). An edit (`supersedeQueued`), an answer
  (`respondToEvent`, which an occurrence sends for its series) or a move
  of it drops the queued delete. Re-queued behind the move, or overtaken
  by an answer sent while it waited out a backoff, the delete removed the
  event on Google after all, and its pending row showed until the next
  pull reported the deletion. A series delete replaced by another change
  of the series first puts back whatever exceptions it still holds, where
  no row is (`restoreTakenExceptions`).
- **Moves and the drain.** A series move still carries an exception's
  delete (a this-and-following cut) along, one that owns no row too, and moves Google's copy of that
  exception with it, for the delete to take when it lands. A page leaves out a
  series a queued move takes out of its calendar, as a task list's pull
  does a moving task: Google lists it there until the move lands, and a
  copy written then showed it in both calendars, the user's edit or
  delete of that copy meeting a 404. Each calendar's events
  pass holds the drain (`whileQueueHeld`) like a task list's, so a delete
  cannot land between a request and the page that would put the row
  back after it, and lets out what was queued meanwhile before the next
  calendar or list (`holdingQueue`), so a write never waits out a whole
  account.
- Cancelled events arrive as tombstones and are kept as `status:
  'cancelled'` rows when they shadow recurring instances. A pulled event
  without a zone takes its calendar's; zones are spelled for the engine
  where events come in and where rows are read (`engineZoneId`,
  `engineRecurrenceLines`: Hermes and V8 accept different IANA spellings).
- **Tasks** (per account, when the `tasks` scope is granted): task lists
  always sync as a full pass (they are few); tasks pull incrementally via
  an `updatedMin` watermark stored in `sync_state` — advanced to "now
  minus 60s" (clock-skew lag) and queried with
  `showCompleted/showHidden/showDeleted` so completions and deletions
  arrive as tombstones. A daily full pass runs `deleteStale` (only rows
  with `sync_status='synced'`). A task a queued change holds takes the
  page into its copy and is rebuilt (`updateCopies`, `heldTasks.refresh`;
  "Pulls and held items" above). Order is read apart from the watermark:
  Google renumbers the siblings on every insert, delete and move without
  bumping their `updated`, but each of those moves the list's own
  `updated`, which the task-list pass already fetches. When it differs
  from the one stored at the list's last order read (`taskOrder:<list>`
  in `sync_state`), the pass writes Google's order onto the list's rows
  and onto the copies of the held ones, then replays the queued moves
  into the list (a task its own move brings back stays out of the parent
  Google still lists it under) and the queued reorders, as after a landed
  reorder — from its
  own listing on a full pass, else from one order-only listing
  (`fields=nextPageToken,items(id,parent,position)`); an idle poll reads
  nothing. That listing names every live task of the list, so a synced
  row it no longer names has left — another device moved it to another
  list, which sends the source no tombstone — and goes, its subtasks with
  it (`removeTasksMovedAway`). Pending rows stay (a queued edit, a create,
  the rows a queued move brought in), and the pass holds the drain. A
  paged listing is no snapshot, so the rows go only while the list's
  `updated` still reads as before the pass (one more tasklists.list),
  else the next pass reads again. A create that lands sorts first among
  its siblings at once, where Google put it; the next pass brings the
  siblings' new numbers. A 403 with the insufficient-scope reason flips
  `tasksEnabled` off instead of retrying forever (older grants without
  the Tasks scope).
- **Google contacts** (per account, when both People API contacts scopes
  are granted — `contactsEnabled`): two tiers, saved contacts
  (`people.connections.list`) and "other contacts" (`otherContacts.list`,
  people you've emailed), each on its own sync token in `sync_state`
  (`contacts:connections`, `contacts:other`) and its own `is_other` rows
  in the `contacts` table (one row per person × email). Incremental passes
  apply upserts and tombstones page by page; a full pass (first run, or an
  expired token) collects everything and `ContactRepo.replaceTier` swaps
  the tier in one transaction. An insufficient-scope 403 flips
  `contactsEnabled` off, like tasks. Device contacts never enter SQLite:
  `DeviceContacts` holds the bridge snapshot in memory, refreshed on
  change notifications, when stale, and after `connectContacts`. The
  `searchContacts` rpc asks `ContactRepo.search` for coarse candidates,
  adds the device list, and `rankContacts` (core) produces one deduped,
  ranked list for the combobox; the UI holds a bounded LRU of query atoms
  on `CONTACTS_KEY`. The connections tier also asks for `birthdays` and
  writes `contact_birthdays` (one row per contact, no email needed) under
  `BIRTHDAYS_KEY`; Google's read-only Birthdays calendar is skipped by
  `syncCalendarList` so a birthday never renders twice.
- **Apple Reminders** (the synthetic `apple-reminders` account, created by
  the `connectReminders` rpc after the EventKit prompt): SQLite holds the
  latest **complete** EventKit snapshot — open and completed, dated and
  undated, so paging any distance ahead or back reads locally, like
  Google Tasks. Where a task is drawn is one rule, `taskCalendarDate`
  (core `taskTiming.ts`): an open task on its due day, or on today once
  that day has passed or when it has none; a completed one on its due
  day, or on the day it was completed when it has no due day or was
  completed late. `getTasksInRange` returns the due-day window plus the
  open undated tasks and the completions around it; `getOverdueTasks`
  returns the open tasks whose day has passed, and
  `partitionCalendarTasks` (core) merges the two without duplicates.
  `syncReminders` checks authorization first — no access flags the
  account, access regained heals it without reconnecting; an
  _unavailable_ bridge is skipped, not mistaken for a revoked grant. The
  bridge's `reminders.snapshot({ changedSince })` returns every
  reminder's (list, id) plus full rows only for what changed since the
  last pass (stamp in `sync_state` scope `reminders`), and
  `TaskRepo.replaceMirror` reconciles in one transaction: ids staged in a
  temp table row by row (iOS's SQLite may cap bound variables at 999),
  changed rows upserted only when strictly newer than what is stored (a
  write-through that landed after the fetch wins), rows absent from the
  snapshot removed only when older than the pass stamp (a row a
  concurrent mutation just mirrored survives). `EKEventStoreChanged`
  (helper event line / Expo module event) runs a debounced (1 s)
  reminders-only pass under the same gate — latency only; the 90 s pass
  is the correctness mechanism, because the notification reaches a live
  observer only.
  - **Writes are EventKit-first and EventKit is the truth.** Once the
    store has committed, a failing SQLite mirror write is logged, not
    raised: the editor would otherwise show an error for a reminder that
    exists and a retried Save would create it twice; our own write fires
    `EKEventStoreChanged`, so the delta pass restores the row anyway.
  - **Save sends only what changed** (`taskEditorChanges`, both
    providers): the diff is against the values the form opened with, so
    an edit made in Reminders.app while the form was open is never
    overwritten by a stale unchanged field. An empty diff closes without
    a write.
  - **Read-only lists** (`EKCalendar.allowsContentModifications` false →
    `TaskListInfo.readOnly`) are never a create/move target and open as a
    viewer. EventKit stays the enforcement — no mutation-layer error.
  - **Wire dates are Gregorian** whatever the device calendar: the bridge
    stamps one explicit Gregorian calendar on written components and
    resolves read components in their own calendar before formatting.
    Every JSON number is range-checked (`boundedInt`) before a native
    conversion — `Int(someDouble)` traps outside Int's range.
- **Account removal vs. an in-flight pass** (both providers): every mirror
  INSERT (calendars, events, task lists, tasks, contacts, birthdays,
  sync_state) is guarded on the account row (`accountGuard`), so a pass
  that finishes after `accountRepo.remove` writes nothing; `replaceMirror`
  reports `skipped` and the engine ends the pass without stamping
  sync_state; removal itself is one transaction. Removing a Google account
  asks first, naming its unsynced changes; an Apple account only
  disconnects.

## Apple Calendar (EventKit events)

- **One synthetic account** `apple-calendar` (`provider: 'apple'`, next
  to `apple-reminders`; tell them apart with `isAppleCalendarAccount` /
  `isAppleRemindersAccount`). `connectAppleCalendar` asks for events
  access — a separate TCC grant from Reminders — and creates it.
- **Calendars are mirrored** (`syncAppleCalendar`): every EventKit
  source (iCloud, Exchange, On My Mac, subscribed) except the Birthdays
  calendar (the birthday lane shows those) and any source titled like a
  connected Google account's email (that account added to Calendar.app
  would show twice). `allowsContentModifications` → `accessRole`
  owner/reader, `defaultCalendarForNewEvents` → `isPrimary`, the source
  title → `CalendarInfo.sourceTitle` (sidebar grouping). `provider` is
  never stored: CalendarRepo joins it from the account. Unavailable
  bridge = skip; lost access = `reauth_required`, healed by the next pass.
- **Events are read through, never stored.** EventKit is already a local
  database and expands series itself; a mirror would need a window and
  could disagree with Calendar.app. `AppleCalendarEvents.eventsInRange`
  asks the bridge for exactly the range a view shows (the bridge chunks
  EventKit's four-year predicate limit) and keeps visible mirrored
  calendars only. There is no range cache: EventKit is local and fast,
  and a cache invites a read from before a write overwriting it.
  `EKEventStoreChanged` (debounced 1 s), every Apple write and
  `setCalendarVisible` invalidate `EVENTS_KEY`. The backend rpc stays the
  single query surface (views, find-a-time, search, agents). A read that
  fails answers no Apple events, so a grid draws the rest; a lookup of one
  Apple event (`lookUpEvent`, behind `findCurrentEvent` and the event
  views that follow their event) asks with `strictApple` instead
  (`eventsInRangeOrFail`, which reads an account flagged for lost access
  all the same, so a refusal fails too), since no stored row stands in
  and an empty answer would read as "deleted".
- **Ids**: a single event is its `eventIdentifier`; an occurrence of a
  series is `<series id>__<occurrenceSlot>` with
  `recurringEventId`/`originalStartUtc` set — the same shape
  `assembleWindow` gives Google occurrences, stable when one occurrence
  is moved or edited on its own (the slot names the occurrence, not its
  start).
- **One identity per series** (`withSeriesIdentity`,
  `packages/apple-calendar/src/seriesIdentity.ts`). EventKit gives an
  occurrence changed on its own an identifier of its own,
  `<series id>/RID=<n>`, and the Swift bridge passes identifiers on
  untouched and compares them literally. The client both apps and the
  fake use is the bridge under this TypeScript layer. What is read names every
  occurrence by its series' id and slot, so the views, search (one hit
  per series), the agent gateway's refs and exceptions and the record id
  all see one series. A write by slot goes to the bridge as it is, which
  finds every occurrence the rule draws; when the bridge has nothing
  there, the layer looks for the changed occurrence and writes it by
  EventKit's own identifier, without a slot. That identifier cannot be
  computed (`<n>` is the slot at the time it was detached, as an instant
  or as a wall clock, and is never rewritten —
  docs/google-sync-and-testing.md): the layer guesses it from the slot,
  reads the guess back (`calendar.series` reads one event by exact id)
  and takes it only if it answers a detached occurrence with that slot;
  failing that it takes the changed occurrence a range read
  `APPLE_WRITE_REACH_MS` (31 days) around the slot returns. So an
  occurrence moved any distance is edited and deleted like any other.
  The one it does not find: moved over 31 days from its slot, with an
  identifier that no longer names the slot (the series' time was changed
  after it was detached). An `id` without a slot is EventKit's and
  passes through — a single event, a series as a whole, or the leftover
  of a split whose id ends in `/RID=` although it is no occurrence any
  more. `calendar.applyBatch` passes through too (mirror copies are
  single events), and `externalId` keeps EventKit's value, so a mirror's
  source keys do not change.
- **Scopes → EKSpan**: instance = `thisEvent` on the occurrence;
  following = `futureEvents` on the occurrence (EventKit splits the
  series at its slot, also from a changed occurrence); series =
  `futureEvents` on the series, named by its id alone — never by the
  first occurrence's slot, which finds nothing once that occurrence was
  changed or deleted on its own — a time edit shifting it by the edited
  occurrence's wall-clock delta, as for Google.
- **A delete never takes a miss for "already gone".** A write by slot
  answers `notFound` for an occurrence that is gone and for the one the
  layer cannot find although a range read still draws it. An update
  shows that error. `deleteRecurring` (instance, following) reads first
  (`findAppleOccurrence` → the client's `occurrence`, which finds exactly
  what the write finds) and refuses a miss with `EventNotFoundError`,
  whatever its reason. Only an occurrence that goes between that read
  and the delete, and a delete by id alone (`deleteEvent`, scope
  series), count as done when EventKit has nothing (`goneIsDone`). A
  conversion reads the occurrence itself before it copies, so its delete
  (`deleteFoundOccurrence`) is not refused for a miss after that read.
  The agent gateway resolves an occurrence for a write the same way.
- **Recurrence** crosses as structured rules (core `StructuredRule`);
  `toStructuredRules`/`toRRuleLines` convert. EXDATE/RDATE/EXRULE,
  BYHOUR/BYMINUTE/BYSECOND, WKST≠MO and COUNT+UNTIL cannot be stored:
  a create is refused (`UnsupportedForProviderError`), a move drops them
  after confirmation.
- **Capabilities**: EventKit cannot write guests or RSVPs — the editor
  hides RSVP for Apple events and shows existing guests read-only; the
  desktop also keeps the invitee field in sight, disabled, with a note
  whose "Open Calendar" brings Calendar.app forward
  (`appleCalendar:open`; nothing opens under the e2e fixture); the
  mutation layer rejects both. A `reader` calendar opens as a viewer, on
  either provider (`writable` guard, `CalendarNotWritableError`; both
  apps also refuse to start a drag there).
- **Moving between calendars** (`moveEvent`, always the whole series):
  Google → same Google account = queued `events.move` (keeps everything;
  organizer only); Apple → Apple = `event.calendar = target` saved with
  the series span; everything else = create in the target, then delete
  the source (a failure between leaves a duplicate, never a loss). A copy
  toward Google is only queued, and Google can still turn it down (a 4xx,
  a calendar or list gone, a discard), so its create carries what it was
  copied from (`PendingOp.copySource`): a Google source's deletes are
  queued in the same transaction and `held` — the drain sends them only
  once no copy holding them is queued (`copyGate`), and makes them due
  when it lands — while a copy that will not land takes them back, which
  puts the source back as Google has it (`releaseCopySource`). An Apple
  source leaves EventKit once the copy is queued — the drain's gate held
  until EventKit answered, so no pass sends the copy first — and rides on
  the copy as it was
  (`appleEvent` with its URL, `reminder`); a copy that will not land
  makes it again — a new identifier, a series without its changed
  occurrences. A copy the user deletes before it goes leaves the queue
  without that: the source goes as moved; one deleted (or moved back to
  Apple) while its create was out is not undone by a later refusal
  either. A copy's discard waits for the drain's gate, so a refusal
  being put back meanwhile is not put back twice. A copy moved on before it
  landed hands its `copySource` to the next copy — at once when its
  create was unsent, when it turns out not to have landed when it was
  sent (`handOn`); once a later copy lands, an earlier one it was moved
  on from no longer puts anything back (`settleHeld`). Removing an
  account, which deletes its queued ops
  without the drain, first releases the sources of the copies queued
  there (`releaseAccountCopies`). Copies
  never carry guests; a Google conference link becomes the Apple event's
  URL, an Apple URL is appended to the Google description; modified
  occurrences are dropped. The editor asks `previewMove` first and
  confirms `moveLossSummary` when anything is dropped, then saves field
  edits at the source and moves. An Apple series' modified occurrences
  are counted from a range read over its first four years
  (`countAppleChangedOccurrences`; the bridge's own `detachedCount`
  compares the series id with identifiers that never equal it and is 0
  on a real store). Converting an event into a task reuses the same
  source loading and series delete (`loadSource`, `deleteFrom`); one
  occurrence is read by `loadOccurrence` and leaves through the instance
  delete (`deleteRecurring`; on Apple as "A delete never takes a miss"
  has it, above).

## Calendar mirrors (packages/sync/src/mirrors.ts, core mirror/)

A mirror copies several sources (Google and Apple calendars, Google task
lists, Reminders lists) one way into one destination calendar, reduced to
an allow-list of fields (presets Availability, Title and location, Full
details, or Custom), so a calendar can be shared without the details.

- **A run is a reconcile, not a sync.** What should exist is computed from
  the sources (`loadMirrorItems` → `buildMirrorCopies`), what exists is
  read from the destination by its markers, and `planMirror` writes the
  difference. Nothing remembers which copy belongs to which source: the
  destination is the state. So any device can run a mirror, a run cut off
  by the OS simply runs again, and two devices running the same mirror
  agree — provided their inputs agree, which is why sources are read with
  their own queries (local show/hide is ignored), "today" and the window
  are computed in the mirror's own `timeZone`, and source keys are
  portable (Google ids; EventKit's external identifier, since
  `eventIdentifier` differs per device).
- **Identity and markers.** `keyHash = sha256(mirrorId | sourceKey)`.
  Google: the event id is `slnvmr` + keyHash (a second insert of the
  same copy gets a 409 and looks before it writes, below), and the private property
  `solunivo.mirror` holds `tag.rev.contentHash`. Apple: the URL field holds
  `x-solunivo-mirror:keyHash.tag.rev.contentHash`. A Google row is a copy
  only when id and property agree, so an event someone duplicated from a
  copy is theirs. `rev` is the definition's `updatedAt`; a device whose
  definition is older than a copy's rev pauses ("changed on another
  device"); after a definition change at least one copy is restamped so
  the other device notices. Everything in a marker is opaque: the
  destination is shared with others who can read both carriers.
- **Writes.** A Google copy is inserted, then updated through `replaceEvent` (PUT: a switched-off
  field must leave the copy; PATCH keeps omitted fields), paced, in chunks
  acked through `applyPage(mode: 'ack')` under the engine's gate
  (`SyncEngine.exclusive`) so a pull cannot interleave. Apple copies go
  through `calendar.applyBatch`, one commit per batch. No guests, no
  reminders (`useDefault: false`, none), the mirror's zone, never the
  source's. Availability merges overlapping events into one block
  (`mergeBusy`, core `scheduling/`); private events copy as the busy label.
- **When a device runs a mirror** (`mirrorResolve.ts`): every source and
  the destination resolve to exactly one row here and their accounts are
  ok; every Google calendar and list involved was pulled successfully
  within five minutes (`sync_state`); no pending op targets a source; no
  other mirror's copies are in the destination; an Apple destination is
  iCloud, CalDAV or local (Exchange drops the URL). Otherwise the status
  says why, in words (`describeMirrorStatus`).
- **Backstops** for what cannot be checked (EventKit never says whether
  iCloud has caught up): a plan that would delete more than
  max(10, 30 %) of the copies with an unchanged definition waits ten
  minutes (or "Run now"); the same create or update made a third time
  within a day pauses the mirror on this device until it is switched on
  again. Deletes are never counted: when a definition change empties the
  destination, nothing carries the new revision, and a device still on
  the old definition writes the excluded copies back until its own
  creates trip its breaker — the device that is right keeps deleting and
  must not pause with it. A Google insert that meets its id (409) reads
  the event first and stands back from a newer revision.
- **Triggers.** A change to events, tasks, calendars, accounts or the
  definitions marks the inputs dirty; a finished sync pass runs the
  mirrors (cheap gates first, the heavy part only when dirty); a heartbeat
  follows midnight in each mirror's zone (undated and overdue tasks move
  to today). iOS runs a budgeted pass at the end of the background task;
  a first fill is foreground work.
- **Storage.** Definitions in `device_settings` `mirrors` (portable: the
  `mirrors` section of the settings document, import adds or updates,
  never removes, and an imported mirror arrives switched off); on/off,
  status, the newest revision seen and the rewrite journal in
  `mirrors.local`, this device's own. Copies are hidden in
  `EventRepo.getWindow` and the Apple read-through: the originals are
  already drawn. The editor can create the destination (Google under the
  `calendar.app.created` scope, Apple in the default account).
- **Tasks** become events by `taskCalendarDate` (above); a completed
  task's copy gets a "✓ " prefix.

## Search (core `search/`, packages/sync/src/search.ts)

- **The query is a struct** (`SearchQuery`, core `search/query.ts`): the
  words typed, and filters — a date range (inclusive days), a place,
  people, calendars and lists by key, events or tasks only, all-day or
  timed. An unset field is "any"; `cleanSearchQuery` drops blanks so
  equal searches are equal values, and `searchQueryKey` is the atom's
  key. Calendars pick events and lists pick tasks; a filter only an
  event can answer (place, people, all-day, calendars alone) leaves tasks
  out; a date range needs a task's due day inside it. With no words, only
  the filters decide.
- **One rpc**, `search({ query, timeZone })`, handled by `searchCalendar`
  for both apps, "now" from Effect's Clock. It reads what the views can
  show over `SEARCH_WINDOW_YEARS` (two) either side of today in the
  primary zone, narrowed to the query's days when it has a range (a past
  range finds a series by its last occurrence there, through the walk's
  backward half; a query only for tasks reads no events, one only for
  events no tasks): the stored rows the range query reads (`EventRepo.getWindow`:
  visible calendars, no mirror copies, no cancelled rows), the Apple
  events EventKit answers for the window, and every task of the visible
  lists (`TaskRepo.getVisible`). Events outside the window are not found;
  full-text search over the stored rows is the way past it (todo.md).
- **A matching series is not expanded over the window** — an hourly one's
  thousands of occurrences would pass the expander's iteration cap.
  `seriesSearchOccurrences` walks it outward from now instead, forward
  and then back only when nothing is left ahead, to its next occurrence
  that is not over, else its latest one. The slots its overrides took
  over are left out of the walk: an override is a row of its own, matched
  on its own text.
- **Matching is TypeScript, not SQL** (`searchTerms`,
  `eventMatchesSearch`, `taskMatchesSearch`): NFD with the combining marks
  dropped, lowercased without a locale; every word of the query must occur
  in one field — an event's title, place, notes, guest names and
  addresses, a task's title and notes. SQLite's LIKE folds neither accents
  nor non-ASCII case.
- **Results** (`buildSearchResults`): one hit per series, keyed by account,
  calendar and `recurringEventId`, at its next matching occurrence that is
  not over, else its latest past one. Upcoming soonest first, past most
  recent first, tasks open by due day, then undated, then completed latest
  first; 50 per group, each with its total. All-day events are judged by
  their dates in the zone, not by their UTC midnights.
- **UI**: `useSearch` (app-state) debounces 200 ms and keeps one atom per
  query in the bounded LRU, so a late answer for an earlier query never
  shows; the previous results stay up while the next load (`stale`), and
  the atoms re-run on EVENTS_KEY and TASKS_KEY. The agent gateway has no
  search tool yet.
- **The search thread** (`useSearchThread`, app-state `searchThread.ts`):
  the field is the words, chips are the filters, a sentence the model
  reads is a turn. Typing sets the words and a chip edit sets a filter,
  neither a turn (the user's own edits); a turn sends the field's sentence with the filters as they
  stand and no words (`parseSearchQuery`, `packages/ai/src/searchQuery.ts`)
  and leaves what is left of the words in the field; Undo restores the
  query before the last turn; Clear empties everything. Turns list
  newest first, only the newest shown until "+N earlier queries" opens
  the rest (`visibleTurns`); a sentence
  being read turns the desktop's ✦ and iOS's "Filters" into a spinner in
  place (no line under the field); on the desktop the turns, and why a
  sentence was not read, hang under the field as one card with it (iOS's
  field is the system's, so its turns are a card of their own), and the
  chips a turn added or relabelled flash (`changedSearchChips`, carried
  on the turn; an Undo flashes nothing). The normalizer
  holds the answer to the words: dates are the code's where it reads them
  (`searchWindowOf`: yesterday, last week, this month, the past N days,
  last Friday, "October 2025" …), else the model's valid days only when
  the words say when, held to the search window; kind and all-day come
  from the words alone; a place, people and calendar or list names count
  only when they are in the words. The router is code
  (`isSearchFilterPhrase`): the desktop's Enter opens the top result of
  plain words and reads words with a filter cue in them, ⌘↩ and ✦ always
  read; iOS's Search key reads words with a filter cue the same way. Without a model the field
  is plain search and the chips still edit by hand (desktop: a popover
  per chip; iOS: a Filters sheet). The fixture model plays a turn in the
  grammar `terms | from..to | location | people | calendar | kind`.

## Recurring events

- Masters carry `recurrence` (raw RFC 5545 lines, no DTSTART — derived from
  the event start in `packages/core/src/recurrence/expand.ts` via
  rrule-temporal; every `RRuleTemporal` is given the app's `Temporal`
  namespace through its `temporal` option, so occurrences are
  `@js-temporal/polyfill` instances on both platforms).
- DTSTART is always the first occurrence, as on Google, even on a day the
  rule skips (and never counted in COUNT): `buildRuleString` lists it as
  an RDATE as well, which rrule-temporal otherwise drops. A set of only
  RDATE lines has no rule: `buildRuleString` gives it
  `RRULE:FREQ=DAILY;COUNT=1`, so it expands as DTSTART + RDATE − EXDATE
  through the same library pass as every rule.
- A generated occurrence whose wall time a transition skips (a daily 02:30
  on the spring-forward day) does not exist: rrule-temporal leaves it out
  and does not count it toward COUNT (RFC 5545 §3.3.10, since its 2.2.6),
  so a five-time series ends a day later; a repeated time is the earlier
  instant. DTSTART in a skipped hour keeps the later reading, and every
  day then repeats that. Whether Google draws that day the same way is
  not verified.
- The views never get masters: `assembleWindow` expands them into
  synthetic instances with id `<masterId>__<originalStartUtc>` carrying
  `recurringEventId` + `originalStartUtc`.
- Editing scopes (`packages/core/src/recurrence/editing.ts` + mutations):
  - **instance** — materialize an exception row under Google's canonical
    instance id `<masterId>_<YYYYMMDDTHHMMSSZ>` (`<YYYYMMDD>` all-day);
    deletes write `cancelled` tombstones. Using Google's own id makes the
    later sync upsert idempotent.
  - **series** — patch the master; time edits apply the occurrence's
    wall-clock delta (`applyWallClockDelta` in `time/dragMath.ts`,
    DST-safe, seconds included: a series at 09:00:30 retimed to 10:00
    starts at 10:00). A date-time UNTIL is read against the moved
    occurrences (`retimedRecurrence`): when the series' last occurrence,
    moved, still falls under the bound but the next one would too (an
    earlier time of day), the bound moves to just before that next one —
    left in place, a cut's `UNTIL = split−1s` drew the split day twice.
    Otherwise it stays: a later time keeps the next occurrence past it,
    and a last occurrence moved past it (a move by days, past an end date)
    is left out, so a cut stays before its split (one that drew from the
    split again would read as undone when the split is pushed) and an end
    date stays its day. It moves only when the moved last occurrence is
    one the moved rule draws: a rule whose own parts fix its days or times
    (BYDAY Fridays, BYHOUR=9) did not move with the start. Round trips and
    a zone's midnight change nothing it reads. A date-only UNTIL, COUNT
    and RDATE/EXDATE values stay. A split moved to
    another time treats the remainder's UNTIL the same way. A new rule (`changes.recurrence`, RFC 5545 lines)
    replaces the master's and drops the exceptions whose slots it no
    longer draws, as Google does with the PATCH; one whose slot it still
    draws stays as it is, moved or cancelled (verified live, see
    docs/google-sync-and-testing.md). One whose slot Google's own rule
    no longer draws (an earlier cut's tombstone a full pull brought) goes
    without a delete: Google draws that slot plain once a rule draws it
    again. `null` ("does not repeat") leaves the master as a single
    event at its own start and drops them all.
    Google keeps a rule whose key is absent from a PATCH, so the op
    carries `recurrenceCleared` and the patch sends `recurrence: []`. A
    master's changed title, description or location is mirrored onto the
    local override rows as a projection of the queued op (`carriedText`),
    since Google copies it onto every exception.
  - **following** — require the split occurrence to be generated by every
    RRULE (`canSplitRecurrence`, ignoring RDATE/EXDATE). Off-rule extra
    dates fail with `RecurringSplitUnsupportedError` and suggest “This
    event” or “All events”, before any cut is committed; changing Repeat
    in the same edit does not bypass this check. This conservative gate
    avoids changing interval phase, implicit weekday or wall time by
    reanchoring DTSTART. Sets of only RDATE lines still split freely.
    The agent gateway checks this before approval and returns
    `InvalidInput` with the `instance` and `series` scope alternatives.
    Then truncate the old master's RRULE with `UNTIL = split−1s`
    (COUNT dropped, RDATE values at or after the split pruned), spawn a
    new master (COUNT recomputed from the RRULE line alone,
    `ruleOccurrencesBefore`; or the edit's own rule; `null` makes the
    occurrence a single event), cancel later overrides. Google gets the
    cut and the new series as one change (`splitSeries.ts`): the new
    master's create names the series it split off, in its calendar, and
    the occurrence it starts at (`splitOf`, `splitIn`, `splitAt`, kept when
    edits fold into it; a move of that series takes `splitIn` along, and a
    move Google never makes takes it back: `moveSplits`) and waits for that
    series' ops that carry the cut, wherever they sit (`holdsSplit`: an
    update that drops exceptions, a series delete that replaced it). An
    event id is its calendar's own: a same-id series elsewhere neither
    holds nor takes it. A
    split of a series whose create is unsent folds the cut into that
    create, which nothing undoes without the series: it names what that
    one was split from, at the same occurrence, or nothing. Folding keeps
    the create's timestamp but re-enqueues it behind rows sharing that
    timestamp (a move gives the whole series one). Occurrence edits wait
    for any queued create of their master in that calendar, regardless of
    queue order. Whether the
    cut was undone, Google says — a discard may meet its request on the
    way or landed with the answer lost, a rejection's revert may fail,
    another device may have ended the series. After an undo (a discard or
    a rejection for good, of the update or of a series delete that
    replaced it, put back in one transaction) the create asks Google for
    the series in that calendar before it goes (`splitCheck`,
    `askSplits`; not while a move of the series is queued: Google has it
    in the source until that lands), and its rows are hidden at once — the
    series shows those
    days itself — to come back as its queued ops wrote them if Google kept
    the cut (a landed occurrence delete puts no tombstone back).
    Once the drain is done with the cut, a landing wrote Google's copy to
    the table, and only a master that is not that, or still draws past the
    split, has it ask (`releaseSplits`). Either way it is due at once,
    not after a backoff that grew while the cut waited, and is stamped as
    sent in one transaction with checking that nothing holds or asks
    again (`splitGate` in applyOp). Where the series still draws from
    `splitAt` on (`drawsFrom`: an occurrence found up to its end, or five
    years on when that cannot be told — a series from decades ago with
    RDATE lines is too long to enumerate — in widening steps, as five
    years of an hourly rule overrun the expansion's cap), the cut was
    undone, and the
    create goes with it (`settleSplit`): with everything queued for that
    series, and its rows. No proof (a rule that cannot be read) keeps it. Keep-theirs has Google's copy and decides at once
    (`dropSplitSeries`).
    One Google ended before (another device cut it too) shows nothing
    twice, and stays. A create once sent waits for nothing. Sent ahead of
    its cut, or left queued, the new series showed those occurrences twice
    on Google.
  - An instance never carries a rule and a single event does not become a
    series through an update (`RecurringEditUnsupportedError`). The
    all-day switch on an existing series is refused
    (`RecurringAllDaySwitchError`) and an all-day series moves one
    occurrence at a time (`RecurringAllDayMoveError`).
- The editor reads a series' master with `getEvent` (`useEventMaster`) to
  seed its repeat fields — an occurrence row has no lines — and sends the
  rule only when it is another rule than the one seeded
  (`repeatChangedSince`). A read-through Apple series
  has no stored master, so its rule stays uneditable in the app.
- The event form's times are two rows, Starts and Ends, each a date and
  (unless all-day) a time: `EditorTimeFields.endDate` is an all-day
  event's last day (inclusive) or a timed one's end day, so a multi-day
  or overnight event round-trips (`editorDatesOf` reads stored times
  back). A new start date carries the end date along. An update whose
  time fields still read as the form opened them sends no times at all
  (`timeFieldsChanged`): a title edit keeps the stored span to the second
  and in its own zone. A this-and-following split always sends them: its
  new series starts at the times sent, the occurrence as the form shows
  it, moved or not (`updateSendsTimes`). An all-day series keeps its dates on a series or
  following edit, so a changed end date asks for "This event" like a
  changed start date.
- An update of an existing event sends only what the form changed
  (`eventEditorChanges`, both apps): title, notes, location with its
  coordinates, guests (by address) and notifications (by what they mean)
  are compared by value with what the form opened with — a snapshot,
  never the live row — and the rule with the one it was seeded with; the
  kind (`isAllDay`) goes only with the times. An edit made elsewhere while the
  form is open (another device, an agent, Google) survives a Save that
  did not touch it; a this-and-following split keeps the series' own
  text unless edited. The location and its coordinates go as a pair
  (`vouchedGeo`, null clearing stale ones), so `withConsistentGeo` judges
  what the user saw. An untouched Save writes nothing; a move still runs.
- Dragging a recurring instance commits an instance-scope override.

## Time-grid gestures

- **Move and resize an event**: desktop `useEventDrag` (pointer capture,
  4 px threshold, 15-minute snap, days by column width; Enter/Space are
  ignored mid-press and a lost capture ends the drag); iOS
  `DraggableEventBlock` (250 ms long press, then drag; one pan for both,
  and a touch-down on the block's bottom 16 pt resizes instead of
  moving). Both commit through `updateEvent` / `updateRecurring` (the op queue
  for Google, EventKit for Apple). A move or resize is wall
  clock in the zone the grid draws in (`moveEventTimes` /
  `resizeEventEnd` take the primary zone), so the block lands on the row
  it was dropped on whatever the event's own zone, and the desktop
  block's label while dragging reads those same times. The desktop hook
  is owned by the app, not the week view, so the panel's
  task rows drag onto the grid and lane too; a task drop is judged by
  where the pointer is released (`dropTargetAt`) under one pure rule
  (`dropTaskChanges`: a grid drop sets day and time, a lane drop clears
  the time, a Google task dropped into the grid is `unsupported` and
  snaps back); a timed block moved within the desktop grid commits its
  snapped delta instead (`moveTimedTask`).
- **Edge auto-scroll**: a task or event drag held in a band along the
  grid's top or bottom edge scrolls the grid, faster toward the edge and
  at full speed past the bottom one (`edgeScrollStep` in
  `packages/core/src/gestures/edgeScroll.ts`, a worklet; 40 px bands on
  desktop, an hour row on iOS, 8 grid hours a second at the edge). An
  edge arms once the drag has been in the grid clear of its band, so a
  chip entering from the lane or a block pressed near an edge does not
  scroll. Every drag offset counts the scroll since the press (desktop
  `deltasFor` adds the scroller's offset change; iOS blocks add
  `scrollY` minus its value at the press to `translationY`), so a scroll
  under a still pointer moves the block with it. Desktop runs a
  `requestAnimationFrame` loop in `useEventDrag` for the whole drag that
  also republishes the drop after a wheel scroll. iOS runs a Reanimated
  frame callback (`useEdgeScroll`, `scrollTo` on the UI thread, offset
  clamped to the content since UIScrollView is not) that bumps a `ticks`
  value the dragged chip and block react to; `scrollY` comes from an
  animated scroll handler, so drops read it in the same frame.
- **Draw a new event's slot**: desktop `useSlotDrag` — press on empty
  grid space and drag, release opens the editor with that slot; only
  vertical travel counts toward the threshold, so a click that drifts
  sideways stays the hour click. iOS `DayColumn` — hold 300 ms on empty
  space (a one-hour slot appears from the quarter the finger touched down
  in), drag while holding to grow it, release opens the sheet with exactly
  the slot shown; the hold slot only grows, so finger drift never shifts
  it. The math is shared (`packages/core/src/time/slotSelection.ts`,
  worklets so iOS runs them on the UI thread), and the editors take it as
  `EventEditorSeed.initialTimes`.
- **A gesture that starts on an event never draws a slot**: desktop blocks
  stop propagation in their pointerdown; iOS blocks are drawn above the
  column's gesture layer. Each hook suppresses the click its own release
  would otherwise turn into an hour click.
- **Paging**: the desktop trackpad pans day columns 1:1 inside a clipped
  strip (`core/gestures/wheelPan.ts`, `--pan-x` written imperatively) and
  eases to the nearest day when the wheel goes quiet. A mini-month day
  (`scrollToDay`) becomes the first column: the strip and the range also
  draw the days slid across (`slideSpan`, at most two windows — farther
  picks start that far short), the offset eases from where they sit — a
  second pick mid-slide carries on from there — a pan grabs a slide
  mid-way, and a held pointer keeps the extra days until it comes up (a
  press holds its strip column). The mini month highlights the visible
  days, so a rolled week crosses two rows. iOS swipes page day
  by day over a drawn buffer per view (`core/layout/dayStrip.ts`), the
  UI thread handing React the pixels navigated so the page change and the
  strip move land in one mount.

## Agent gateway (desktop)

Other agents on the Mac get in through one more door, not through the rpc
seam: a Unix socket in the main process (`apps/desktop/electron/agent/`)
that authenticates a per-agent token and then serves MCP or one CLI
command, both over the same tool set. Every call goes through `callTool`
(`packages/agent/src/gateway.ts`) on the backend runtime — the same
services the renderer's rpc handlers use, with the agent store's services
(a second, tiny runtime over `agents.db`) provided into each effect. The
backend itself has no caller identity or permission checks, so the
gateway carries all of it. Details, limits and the threat model:
`docs/agent-gateway.md`.

## Onboarding (first run and Getting started)

- **State.** One `device_settings` key, `onboarding` (core
  `onboarding.ts`: `OnboardingState` — the card `expanded` / `collapsed` /
  `hidden`, a mark per lesson, `done` or `skipped`, and how the setup
  ended), read over `getOnboarding` and changed over `updateOnboarding`:
  a window sends what changes (`OnboardingChange` — the card, the setup's
  outcome, one lesson's mark, a reset), never a whole state, and the
  backend applies it to what is stored under a lock
  (`applyOnboardingChange`), so two windows' changes, or a frame ticking
  skipped as the next lesson ticks done, both land. A try is never
  downgraded to a skip (`withLessonMark`). Per device: not in the
  settings document and not a settings-file trigger key, so a copied
  setup starts its own lessons.
- **First run.** Shown when nothing is connected and the setup was
  neither finished nor skipped (`useSetupNeeded`, null until the accounts
  and the state are read), decided once per launch (iOS) or window (Mac)
  from that first read — removing the last account later does not bring
  it up mid-session. Once ended, a late answer (a permission granted
  after Skip) changes nothing. iOS: a `fullScreenModal` route group
  `app/setup/` the calendar pushes, its pages sharing
  Settings' `SettingsProvider` (statuses, Google sign-in, device
  connects) and a `SetupProvider` (the ticked sources, the steps they
  lead through). Mac: `SetupDialog` on `Dialog` in the calendar window's
  root, latched open until finished — the first account it signs in
  ends "nothing connected" mid-flow — except an untouched Welcome, which
  closes again when accounts arrive another way (the watched settings
  file is imported a beat after launch). The Google step's Tasks box is
  `AddAccountParams.tasks` → `googleScopes({ tasks })`; the copy door
  reads the other device's settings code (camera or paste; a settings
  file still imports there — see "Settings code" below) and lists what
  the device still has to do.
- **Card and lessons.** `lessonRows` gives the card its rows ("Add your
  accounts" first while nothing is connected); the card leaves once every
  lesson is ticked. A lesson is an existing surface plus a frame: Create
  with AI is the editor's Assistant seeded with `quickAddText` + `lesson`
  (`EditorSeed`; the phrase waits in the Assistant's field, which the
  iPhone opens on) under a `LessonBanner`. Without the Assistant's model
  (not asked for, downloading, failed, or a device that cannot run it)
  it runs a demo on the same editor instead of the Form: the reader is
  `tunedReader(lessonDemoModel)` (`@calendar/ai` `lessonDemo.ts`: the
  published model's recorded answers to `LESSON_DEMO_PHRASES`, the
  phrase and "at 1 instead", a day written as a count from today so it
  holds on any date, recorded again with each version; anything else
  refused), the field holds the next of them
  (`lessonDemoNext`) to send as typed words are, and the banner says
  what the Assistant is and offers the download, then its progress
  (`lessonModelCopy`); the card's Create row says where the download
  stands (`createRowNote`). Once the model is ready the reader is the
  model's and the banner says so; a device that cannot run it gets the
  demo, then the Form. Search with AI is search with its sentence read (the
  desktop panel's thread, iOS route params on the Search tab); Alerts,
  Contacts, Time zones and "Set up your Mac/iPhone" frame the Settings
  sections (iOS `app/lesson/` modal, desktop `PanelState` `lesson`; "Set
  up your Mac/iPhone" shows this device's settings code behind Show Code,
  the export kept under it). A section reports a change that went
  through — a setting saved, an access granted, a file shared, the code
  revealed or copied — through `useLessonTried`
  (`LessonTriedContext`; nothing outside a lesson), which ticks the
  lesson done; leaving a frame without one ticks it skipped. Once tried,
  a banner keeps its hint and loses Skip. Settings › Getting Started (iOS page,
  desktop pane `gettingstarted`) reopens lessons — the desktop's through
  `lesson:open` IPC, which keeps the lesson in main, shows the calendar
  window and nudges it; the calendar collects it with `lesson:take` when
  nudged and when it subscribes, as with `notifications:take` — and Start
  Over clears the ticks.
- **Switches.** `CALENDAR_ONBOARDING=off` (desktop, answered over
  `onboarding:enabled`; the e2e harness's default) and
  `EXPO_PUBLIC_CALENDAR_ONBOARDING=off` (the CI and live iOS bundles) keep
  the setup and the card away whatever the state says. Under the fixture
  model the iOS `onboarding-fixture` deep link resets the state and forces
  both on for that launch (flow 26); `?assistant=absent` on it has the
  Assistant's model read as not asked for, for that launch, so the
  Create lesson runs its demo (flow 28). Under the fake Google API "Add
  Google Account" signs the fixture in (`fixtureSignIn`).

## Platform seams

- **After creating an item (both apps).** A successful create publishes
  its saved event fields or to-do due day from `useThreadEditor` through
  `createdItem.ts`. `useCalendarNavigation` shows that date; a repeating
  event uses the occurrence nearest the visible days (one in view first,
  later on a tie), including a month grid's outer rows and excluding the
  fetched buffer. An occurrence overlapping any drawn day preserves the
  current window, including multi-day and overnight events. An undated
  to-do or an invalid due date leaves the view alone. Edits, conversions,
  deletes and failed writes do not publish a creation reveal; a reply
  after the editor unmounts is ignored.
- **rpc vs IPC.** Calendar data crosses process boundaries **only**
  through the typed rpc seam (Apple events, reminders and contact rows
  included). Window-level concerns use plain preload IPC
  (`apps/desktop/electron/preload.ts`): `renderer-error` (→
  `userData/logs/main.log`, 1 MB rotation), `privacy:*` (screen-capture
  protection, off by default, stored in `userData/settings.json`;
  `privacy:capture` says a screenshot or recording is leaving the windows
  out — macOS gives no such signal, so while privacy is on and a window is
  on screen the helper's `capture.watch` polls the process table for the
  system's `screencapture` tool, `electron/captureHint.ts`), the
  `model:*` channels, the `reminders:status` / `contacts:status` /
  `appleCalendar:status` permission asks, `settings:open`,
  `model:provider-*` (which model answers — Apple's helper or a model
  served over HTTP, `electron/modelProvider.ts`: the choice, endpoint and
  model name in `userData/model-provider.json`, an API key only as
  safeStorage ciphertext, every window hears `model:providerChanged`),
  `settingsFile:*`, `auth:cancel`, `notifications:take`, `rpc:document`
  (a reload re-registers the page as an rpc client) and `agents:*`
  (device-local, never rpc, never exported). The window-open handler sends
  Join-meeting links to the system browser.
- **Main process.** Single-instance per profile
  (`requestSingleInstanceLock`, taken after the `CALENDAR_USERDATA`
  override); keeps running without a window on macOS, and `windows.ts`
  opens one on demand (Dock, a notification click, a second launch).
  `--background` starts without a window — what the agent relay passes
  when it has to launch the app. A content-security policy is applied
  outside dev and reaches the packaged `file://` page; `will-navigate` and
  `setWindowOpenHandler` allow-lists cover every web contents.
- **Two windows, one renderer bundle.** `renderer/main.tsx` mounts the
  calendar, or the settings window when the page was loaded at `#settings`
  (`showSettingsWindow`: one at most, fixed 780×560, not minimizable or
  maximizable). Settings opens from the application menu (`menu.ts`:
  Settings…, ⌘,) — also with no main window — or over `settings:open`. It
  is a sidebar of panes (Accounts, Calendar, Notifications, Time Zones,
  AI Model, Dictation, Screen Sharing, Settings File, Getting Started,
  Advanced, then Mirrors
  and Agents under
  an "Experimental" heading) with a search field (`filterPanes`). The pane is the URL hash (`#settings/<pane>`): the main
  process moves an open window by navigating the hash, the page only ever
  reads it. Each window is its own rpc client with its own atoms, kept in
  step by the invalidation stream; `privacy:changed`, `privacy:capture`,
  `agents:changed` and `settingsFile:changed` go to every window. The agent approval dialog,
  the conflict banner and the dropped-change toast live in the main
  window only. Find the main window through `showMainWindow` /
  `hasMainWindow`, never `getAllWindows()[0]`.
- **Modal surfaces (desktop).** `Dialog` (the modals) and `Popover` (a
  panel anchored over a transparent backdrop: the Getting started menu,
  the search filter editors, the calendar color picker) share two
  pieces. The window's dialog stack (`dialogStack.ts`) gives Escape to
  the topmost surface alone and makes the calendar's own keys stand
  back. `ui/FocusTrap.tsx` keeps the keyboard inside: focus moves in on
  open (a `data-initial-focus` control, else the first, unless an
  `autoFocus` field took it), Tab and Shift+Tab cycle, a control removed
  with focus in it leaves focus on the panel itself, and the opener —
  read while rendering, before React's commit runs `autoFocus` — gets it
  back on close. A dialog that replaces another in one commit (the
  agent's next request) gives focus back where that one did. Tab is
  never intercepted: a focusable guard on each side of the panel catches
  focus on its way out and passes it to the other end, so a date or time
  field keeps Chromium's segment-by-segment Tab.
- **Theme.** `brand/tokens/tokens.json` is the one source. `pnpm
  brand:build` writes `brand/tokens/tokens.css` (`:root` and
  `[data-theme='dark']`) and `packages/core/src/theme/tokens.ts`
  (`THEMES.light/dark`), both guarded by `brand:check`. The desktop
  imports the CSS; the hand-written `brand/tokens/tailwind.css` (imported
  by `App.css` and the website) maps every variable into Tailwind's theme
  (`bg-canvas`, `bg-fill`, `text-ink`, `border-hairline`, `bg-primary`, …
  — the renderer's only colors; `themeClasses.test.ts` fails on Tailwind's
  own palette) and `renderer/theme.ts` mirrors `prefers-color-scheme` onto
  `data-theme` before the first paint. iOS reads the TS module through
  `useTheme()`. Calendar colors are arbitrary hex, so every
  calendar-colored block or chip goes through `eventTint(hex, scheme)`:
  hue and chroma from the calendar, lightness from the theme, text on
  fill at 4.5:1; the brand `event-*` tokens are for items with no
  calendar. A box that asks or warns uses `CALLOUT_CLASS`. Text that acts
  takes a second cue, since `primary` is the text's own charcoal: a link
  inside a sentence `TEXT_LINK_CLASS`, a standalone text action
  `TEXT_ACTION_CLASS.primary` / `.danger` (`ui/buttonStyles.ts`; the theme
  test also fails on a hand-made `hover:underline`), and on iOS
  `actionText(colors)` (`src/ui/theme.ts`), with Cancel / Close in
  secondary text.
- **Desktop shell** (`renderer/calendar/`): a toolbar (`Toolbar.tsx`:
  sidebar toggle, title, ‹ Today ›, Day/Week/Month, Search, the Today
  panel toggle, New), a collapsible sidebar (mini month, calendars and
  lists per account — a click anywhere on a row shows or hides it, and
  a calendar's color changes in Settings › Accounts — the sync footer
  with the unsynced changes), the
  grid, and a side panel (`panel/`, 360 px whatever it shows) that is
  one `PanelState` in `CalendarApp.tsx`: the Today rail at rest
  (`UpNextCard` + `TaskInbox`),
  search (⌘F), an event's read-first inspector after a grid click or a
  search result (`EventInspector.tsx`), or the inline editor
  (`EditorPanel.tsx`) from Edit, a slot, New (⌘N; ⌘K goes
  to the Assistant's field, an open editor's too), a task chip or a result. The editor
  is a header that stays (the title, the Assistant | Form tabs, Join
  meeting, Close), one of two views of the same draft, and a footer that
  stays (the steps, Delete · Cancel · Save; above them an older step's
  "Use this" row, why a save was refused while the Assistant covers the
  form that says so, and the question before a lossy change), so the save
  and the way out are in reach from either view. Single
  keys: T = today, ←/→ step the view; ⌘, opens Settings from the menu.
  The editor is a thread of drafts (`useDraftThread`,
  `packages/app-state/src/draftThread.ts`) with two views, both mounted
  (`EditorPanel`). Switching, the form rises out of the newest card —
  its title starts on the card's — and folds back into it (Web
  Animations, `panel/useViewSwitch.ts`, the anchor rule shared with the
  iPhone: `viewSwitch.ts`); the pane leaving stays drawn under the one
  arriving, `inert`, until the motion ends (`data-switching`), the
  conversation scrolled to its end before its card is measured, and a
  click back mid-way turns it round; under Reduce Motion it is a
  crossfade. "+ New",
  ⌘N, ⌘K and a capture open on the Assistant —
  falling back to the Form once when the model turns out not to be ready
  before anything was said (not the Create lesson, which runs its demo,
  see Onboarding) — a slot, a to-do and a saved item on the
  Form; a read-only item and a conversion have the Form alone.
  **Assistant** (`assistant/AssistantView.tsx`) is a conversation: a
  phrase, typed and sent with Return or dictated hands-free, makes the
  draft(s) or changes them (the Assistant's own model, `tunedReader`;
  while it is not on the Mac the notice shows its download,
  `AssistantModelNotice`); each answer is the item as a
  card (`AssistantCard`, its lines from `cardLines`) with what the step
  changed marked and the old value struck through; a step not on show
  is a row with Restore; what the assistant has to ask sits under the
  newest card (`DraftQuestions`: free slots, for a saved series what a
  change applies to, then its questions one at a time in a
  `QuestionCard` — which place a text means, which contact a name —
  numbered among those its phrase brought, "Question 1 of 2", with
  Skip; `draftQuestions.ts`). Which place shows its places on one map
  above the rows, numbered like them; the card shows the place it holds
  on a map of its own once nothing asks which. Core's `placeMapLayout`
  fits the places within a day trip of each other, stands pins that would
  cover each other on legs from their places, and makes a place farther
  off a tag on the map's edge (its row says how far, `farMeters`), the
  pins kept clear of a side that holds one; both apps draw their own
  pins over a MapKit image of exactly that rect (`mapSnapshot` with
  `rect`, `usePlaceMap`), and the iPhone opens it full height as a live
  map (`PlaceMapSheet`). What it is doing, and why a phrase failed, is a
  line under the field, the failed words kept in it. Words the model
  read that leave every draft as it was (`leftAlone`: no field the card
  or the form shows, no question opened or settled, no day for an
  undated to-do, no free slots of their own, an assumed time still
  assumed) make no step: they stay in the conversation after the step
  they followed, answered "Nothing changed." — with why, where they
  asked for what the draft cannot hold ("At most 5 notifications.") —
  (`NoChangeTurn`, `noChangeLines`), and go when that step is let go of. Dictated ones
  then try the recogniser's other readings in the background, one model
  turn each (`otherReadings`), and offer those that would change
  something with what they would do; one is said, as typed words, only
  when picked. **Form** is the
  fields as captioned sections — the Event | Task | Reminder control
  (`useEditorKinds`, only the kinds something can hold; on an existing
  item it converts), When, Where, Invitees, Notifications, Notes
  (`FormSection.tsx`) — and needs no model. Under both is one history of
  **steps**: a phrase, an edit by hand (further edits to the same field
  join it, `foldForm`) and a picked choice. The footer steps back and
  forward through them (`stepTo`); an older step on show is looked at,
  not edited — the form is locked, Save is off, dictation ends
  (`useQuickAddModel`'s `off`) — until "Use this" keeps
  it and lets the later ones go (`keepShown`) or the newest is shown
  again. The fields the step on show changed stay marked, in the form
  (`data-marked`) and on the card (`shownMarks`, over `draftChanges`:
  what differs between two states of a draft, field by field, as
  values; `threadSteps.ts` names and summarizes a step for both apps).
  A saved item's thread starts as the item itself (`openThread`, "As
  saved"): a phrase changes it at the scope the form is at, what it
  cannot hold is refused in the conversation with Save's own sentence
  (`turnRefusal`), and Save sends only what differs from the saved item
  (`eventEditorChanges` compares values; there are no dirty flags).
  What a draft's calendar or list does not keep is neither taken from a
  turn nor shown (the editor's `keeps(draft)`): a to-do, new or saved,
  takes no time of day and no alert on a list that keeps a due day only
  (a Google task: `todoTimeRefusal`, `todoAlertRefusal`), an event no
  change of guests on a calendar that takes no guest list
  (`guestsRefusal`), and the card and rows leave out a time, alerts or
  guests a draft carries from a first phrase (`DraftKeeps`). A to-do kept without a due day is dated by a turn that
  gives a day or a time — also the day it already reads, where the
  words state it (a refinement's `saidDay`). A place is its text and
  its pin: another point picked under the same text, or the pin let go
  of, is a step too (`draftChanges`). The form takes each step in from a
  layout effect, in the commit right after the one that draws it, in the
  same task and before paint (a to-do's own fields land with its item):
  the screen, and anything reading the page from another task, show the
  step control, the card and the form at one step, the steps unlocked.
  Only a kind switch, by phrase or by hand, leaves the form between two
  states of a draft (`applying`: its question asked, its fields carried
  over); meanwhile the steps are locked and
  the pager, Remove and "Add all" wait (`draftsSettled`); a reading of
  the form names the draft it is of (`FormSnapshot.shown`), so it never
  lands on the one focused meanwhile.
  A phrase that asks for free time (`proposeSlots`)
  puts the draft in the best free slot and keeps the others on it — a
  "Free slots" chip row under the card, the chosen one pressed, and
  fainter dotted candidate blocks tagged "Option" on the grid, either of
  which moves the draft; the next phrase drops them, the step before
  brings them back; the grid draws every event draft hatched and dashed
  in its calendar's hue with a "Draft" tag (`DraftBlock`, `DraftChip` in
  the lane; `draftPreview.ts` derives them from the thread — one union
  on `kind`: a draft, a candidate, or `was` — the focused one from the
  live form, every occurrence of a repeating one), the focused draft
  outlined and its day shown, and a dashed outline where the step on
  show moved it from (`DraftTrace`: over the column, outside the day
  layout, so it never narrows a block; not where a saved event's own
  block still stands); a click on a block or the pager — under the
  header in either view (`panel/DraftPager.tsx`) — swaps the form. Each draft keeps what the form held for it — its
  kind, the calendar or list picked, guests, notes, a reminder's own
  fields (`DraftExtras`) — and another draft taking the form shows as it
  was left, not as a kind switch: nothing carries over, nothing is asked
  (`useEditorKinds().show`); a draft the form never held takes the form's
  calendar and list, so one pick reaches every untouched draft. Save
  writes the focused draft (and keeps the editor on the next while there
  are more); "Add all" the others as they stand, events and to-dos alike,
  each where it was put, after Save's own checks (`planAddAll`,
  `addAll.ts`). Capture opens its events as one such thread
  (`useCaptureModel.onMany`) rather than a review list. The panel renders
  `useThreadEditor` (`packages/app-state/src/threadEditor.ts`), which the
  iOS edit sheet shares: both editor models, the kind control, the thread
  and everything between, and whether closing now would lose something
  (`unsaved`, `editorUnsaved.ts`): a new item's drafts — a share's
  untouched ones too — or a form that reads otherwise than it opened
  (`useFormChanged`, one JSON reading of the form on show, so a field
  put back is no change; read as the editor opens, with an event's rule
  in it only once the person changed it — a series' rule arrives after
  the editor opens and seeds itself — and a new item switched to another
  kind, or round again, before anything was put in opens that form
  afresh). An editor opened to convert counts its edits by hand
  instead, since its form fills as it opens; a birthday and a read-only
  item never hold anything; a Save, delete or "Add all" being written,
  its question answered (`askFirst`), excuses the draft on show, not a
  capture's others. The calendar and the editor exchange drafts, a
  day to show and a clicked draft through kept-alive atoms
  (`draftAtoms.ts`: `useDraftPreviews`, `useOnDraftReveal`,
  `useRequestDraftFocus`). The panel never
  joins the dialog stack (`dialogStack.ts`), so a real
  dialog over it keeps Escape; a panel opened from a
  search result closes back to the results. The inspector follows its
  event by identity (core `eventIdentity`), reads from the grid's current
  row (or `findCurrentEvent`), and closes when the event is gone; an
  editor keeps its seed. An editor's own close (Cancel, or Save and
  Delete once the write answers) applies only while the panel still
  holds its opening, and the inspector's Delete only while the panel
  shows an event that delete took (`deleteTakes`: the event, or with a
  series' scope its siblings; an editor opened on one meanwhile
  included), so a late reply never closes what was opened since.
  Every other way the panel changes goes through one gate
  (`CalendarApp`'s `setPanel`): while the editor holds something it
  would lose (`useThreadEditor().unsaved`, or words in the Assistant's
  field — `EditorPanel` reports both up), a change that would take it
  off the panel — Cancel, the X, Escape, another event, slot or chip,
  "+ New", search, a lesson, a paste, a notification — is held and the
  editor asks above its footer (`DiscardConfirm`: Keep Editing, which
  has the focus and Escape, or Discard Changes, which goes where was
  asked). Only an editor's own close after its write bypasses it.
  Notices (`NoticeStack`: failed write, discarded
  change, conflict banner) stack in one column inside the grid's area.
  Every editor write runs through one slot (`useOneWrite`); deletes ask
  first. An async action outside the editors (a Settings save, a delete
  dialog, an import) runs on the same slot helper through `useAction`
  (`packages/app-state/src/action.ts`), which also holds its outcome as
  one value: idle, running, failed with its line, or done with what the
  task returned. `lastView` and `sidebarCollapsed` are device taste in the view
  preferences, read before the first paint.
- **iOS shell** (`apps/ios/app/`, expo-router): `_layout.tsx` mounts the
  providers, the editor host and a native stack with the tab bar
  (`(tabs)/`: Calendar · Tasks · Search, the last a stack of one screen
  whose `Stack.SearchBar` is the system search field) and Settings as a
  modal route holding its own native stack (`settings/`: the root list, a
  page per pane; rows drawn by `src/ui/GroupedList.tsx`,
  switches through `@expo/ui`; small titles only — a large one on a root
  that scrolls froze iOS 26 on Back). `src/ui/CalendarScreen.tsx` is the
  calendar tab: a header (title, the view menu Day · 2 Days · Week ·
  Month · Agenda, ‹ Today ›, the account avatar into Settings carrying the
  unsynced badge), the week strip, the timeline / month grid / agenda,
  and the "+" (`AddButton`, shared with the Tasks tab: the calendar's
  opens a new event, the Tasks tab's an undated to-do in the filtered
  list). `EditorHost.tsx` owns every sheet — event, task and reminder details, the editor
  (`EventEditSheet`, the same thread as the desktop, `useThreadEditor`,
  in the same two views), the birthday detail, a fold chip's list — and the capture model behind the share
  sheet and deep links, whose events open the editor as one thread of
  drafts; each opening is keyed by its own number; screens ask it
  through `useEditorHost()`. The detail follows its event as the
  desktop inspector does, keyed by identity: it has no grid range of its
  own (it opens over Calendar, Search and tapped reminders), so it reads
  `useCurrentEvent` — `findCurrentEvent`'s lookup as an atom
  (`currentEvent`), read again whenever events change — shows that
  record (`eventReadout`), seeds Edit and Convert from it and closes once
  the event is gone; a failed read keeps it up. Tasks and reminders also
  open a detail first from Calendar, Tasks, Search, fold lists and notification
  taps. Their detail reads `useCurrentTask` (`getTask`, refreshed on task
  changes), including completed and undated records. A bounded session alias
  follows a Google create from its temporary id to its server id; the raw
  repository reads stay exact, so a rolled-back swap still finds its temp row.
  Google lookups stay within that list, since another list can hold the same
  server id. Only Reminders follow an external list move by stable EventKit id.
  Detail actions use the saved record without a seeded editor destination; Edit starts from the
  latest row, Cancel returns to its detail, and completion closes only its
  originating detail. Deletion also closes an editor still showing the removed
  task. Custom sheet header actions use
  `SheetButton`, the editor's 44 pt neutral or primary capsule.
  The detail and the editor
  share the `editor` route (`app/editor.tsx`), a page sheet at full
  height like Settings — a form sheet lays out a header and one scroll
  view and nothing else, so it could hold neither a bar at its bottom nor
  two views. The host pushes the route when either opens and pops it when
  the state leaves both; from one to the other only the content changes,
  the old fading out as the new fades in (`RouteFade`, a fade under
  Reduce Motion too, none while the sheet slides): Edit and Convert turn
  the detail into its editor, the editor's Cancel turns it back
  (`cancelEditor` over the editor's `backTo`), Save and Delete close the
  sheet, and a swipe that dismisses it closes the detail and the editor
  alike. Only a swipe closes them as the route goes: after the host's
  own pop the state has moved on, and a detail asked for while the old
  sheet leaves (a tapped reminder) goes up once it has gone
  (`routeMove`, `routeDismissed`). While the editor holds something
  it would lose (`unsaved`, or words in the Assistant's field), Cancel
  and the lesson's Skip ask first with an action sheet (HIG → Sheets:
  Discard Changes or Keep Editing), and so does a swipe down: the
  editor holds the route with expo-router's `usePreventRemove`
  (`discardGuard.tsx`), which sets the sheet's `isModalInPresentation`,
  so the sheet springs back and the attempt asks; Discard closes the
  whole sheet, as a swipe does. The guard holds only while the host's
  state names that opening (`open`): the host's own close — Save,
  Delete, a share, a tapped reminder — releases it in the same commit,
  and expo-router decides a blocked pop when its reducer runs, after
  that. A share, a reminder or a settings code arriving over an
  editor still replaces it without asking. The editor's
  own close (Cancel, or Save and Delete once the
  write answers) applies only while the sheet still holds its opening,
  and the detail's Delete only while the sheet shows an event that
  delete took (`sheets.ts`, over `deleteTakes`), so a reply landing
  after the user moved on leaves what was opened since. UIKit presents
  one sheet at a time, so the push waits for a page sheet (birthday, a
  fold's list) or the route's previous sheet to slide away, and a page
  sheet asked for as the route closes waits for its sheet (the route
  unmounts as its sheet starts to leave, not after). Nothing stacks on the editor: it closes before
  Settings opens, so the host's pop is always the editor's. A capture
  runs under a banner that blocks nothing; its thread never replaces
  what the user opened meanwhile (an editor, a detail, a birthday,
  Settings) but opens once that has closed and the editor's sheet is
  gone (`captureMayOpen`). A new share drops a waiting thread, as does a
  tapped reminder whose detail opens. The sheet is a header (Cancel ·
  title · Save, the two as 44 pt capsules), the pager when there are
  several drafts (`assistant/DraftPager`), then one of two views, one
  mounted at rest; switching, both are, the form rising out of the
  newest card and folding back into it on one shared value on the UI
  thread (`assistant/useViewSwitch.ts`: the two titles measured where
  nothing moves them, the one leaving out of touch and VoiceOver's
  reach, a tap back mid-way turning it round, a crossfade under Reduce
  Motion or with the keyboard up); the way between them is one capsule
  at the bottom right that stays put and changes its word
  (`SwitchCapsule`), the bar's microphone shrinking into its glyph. The
  **Assistant** is the desktop's conversation
  (`assistant/AssistantView`, `AssistantCard`, `DraftQuestions`) over a
  bar at the bottom by the thumb (`AssistantBar`: Type · the microphone ·
  Form, the two words as quiet capsules either side of the one loud
  control). Speaking is the way in; Type swaps the bar for a field with a
  send button that pads itself above the keyboard (`useKeyboardInset`,
  over `keyboardOverlap`), and the field giving up the focus brings the
  bar back, its words kept. The **Form** is the kind control and the
  form rendering `bare` in one scroll view (`FormScroll`); over its
  bottom edge float the steps (`StepPill`), the way back (the sheet's
  one `SwitchCapsule`, which is Form in the bar and Assistant here)
  and an older step's "Use this" (`UseStepCard`) — not while the
  keyboard is up, and out of the way while the form is scrolled down,
  back on a scroll up (`pillTuck.ts`, `TuckAway`; never under
  VoiceOver) — and an older step on show takes no touches. The phrase and the
  dictation state (`useQuickAddModel`) live in the sheet, above both
  views: a flip keeps the words and the listening, an edit by hand or
  an older step put on show ends it. Why a save was refused is a line
  over the bar: the form that says so is not mounted then. The
  calendar's "+", a share and the Create lesson open on the
  Assistant (`EditSheet.opensOn`), falling back to the Form once when
  the model is not ready (not the Create lesson: its demo); a slot drawn on the grid, a to-do's "+" and a
  saved item open on the Form. The rows the step on show changed stay
  marked (`FlashView`, `lasting`). The sheet covers the calendar, which
  draws no drafts on the phone; it still goes to the focused draft's
  day and hour (`useOnDraftReveal`, `revealMinute`), so a saved item is
  in view once the sheet has gone. The forms are iOS inset grouped
  cards on the grouped ground, drawn with the Settings pages' rows
  (`GroupedList.tsx`:
  `Section`, `Row`, `SwitchRow`, `CheckRow`, `ActionRow`, and the forms'
  own `FieldRow`, `ChipsRow`, `RowSlot`, `CardCaption`; a choice is a
  `Chip`). The event form starts with the title, then all-day, the dates
  and the finder, followed by the location and its map. Calendar, repeat,
  invitees, notifications, notes and Delete follow. The to-do form
  follows Reminders' order (title and notes, list, due day and time,
  repeat, priority, alert, URL, Delete). A card's header
  renders uppercase, which is what the flows tap to dismiss a keyboard
  ("LIST").
  `+native-intent.tsx` keeps non-route URLs on the calendar. The other
  sheets are React Native page sheets; `@expo/ui` is used where it is a
  drop-in.
  Text that cannot grow (grid blocks, chips, the gutter, bars) is capped
  at `BOX_FONT_SCALE` for Dynamic Type; the rest scales fully.
- **Views**: day/week time grid (with "2 Days" and a two-week agenda on
  iOS), month grid, and an all-day lane for date-only tasks. Expanded,
  the lane takes at most a third of the view (`expandedAllDayRows`) and
  then scrolls inside itself, stopping halfway into the next chip;
  collapsed, it shows three rows with "+N more". The chevron under
  "all-day" switches the two (a device setting). On today, two or more
  overdue or undated tasks fold into one chip per group
  (`foldTaskBacklog`) that opens their list: a popover on the desktop
  (rows tick, open, or drag onto the calendar), a page sheet on iOS
  (`TaskFoldSheet`, held by `EditorHost`); a list keeps the rows it
  opened with, so a ticked one stays, struck through. Timed Apple
  Reminders share the day-column overlap layout with events as compact,
  move-only blocks; their due time is wall-clock data, and the day column
  is a fixed 24-hour wall clock (`layoutDayColumn` places every box by
  wall-clock minute, so DST days draw as Google Calendar does). Task
  checkboxes are drawn (`TaskCheck`), never glyphs. Month cells show
  tasks and birthdays after the day's events as read-only summaries
  (events keep the cap — they carry the calendar's color), announce their
  counts through `monthCellLabel`, and open the day; both kinds are
  bucketed with `groupByDate`.
- **Birthdays** are a third all-day kind, not events: `getBirthdaysInRange`
  merges the Google People cache and the device snapshot
  (`DeviceContacts.birthdays()`) by folded name + MM-DD
  (`mergeBirthdays`, `birthdayMergeKey`), expands occurrences per day
  (Feb 29 lands on Feb 28 in common years), and both lanes draw a neutral
  chip with a fixed pink accent (`birthdayChipLabel`). The detail view
  lists every source; the birthday itself is read-only, and the one thing
  it edits is that person's reminders.
- **Locations and maps**: Google stores only location text, so
  coordinates (`EventRecord.geo`: lat, lng, name, and `source`, the text
  they came from) are derived on-device through `GeoClient` (MapKit) and
  are valid only while `source` matches the location (`geoMatches`;
  every local write goes through `withConsistentGeo`). They travel in the
  event's private extendedProperties, so other devices skip geocoding.
  Only coordinates the user vouched for are mirrored: the event's own or
  a picked suggestion. A local edit that drops them flags its queued
  update `geoCleared`, and only that PATCH deletes the keys with nulls.
  Events without mirrored coordinates are geocoded when the editor or
  detail opens
  (`resolveLocation`, cached in the device-local `location_geo` table:
  misses for 3 days, hits refreshed in the background after 14 days,
  pruned to 2000 rows, wiped from Settings) for its map; these lookup
  results are never mirrored. Typing never geocodes — the typeahead
  (`searchPlaces`) and a picked row do. The typeahead asks MapKit's completer, which reads only
  how a name begins; where it answers fewer rows than asked for and none
  is the text itself, the latest text goes to the search too, which
  reads a misspelling ("kaffeemik"), and the places it names come first
  — or in the completer's own row where it lists them too — each with
  its coordinates, so a pick needs no lookup (core
  `withFoundSuggestions`): at most `FILL_IN_LIMIT` times a minute, since
  MapKit throttles searches, not completions, and a throttled minute
  fails the pins and picks too. URLs and meeting links are never looked
  up. A search answers something for almost any text ("Room 4" found a
  street in Weidling, "Cafe Meek" a café in South Africa), so free text
  gets a pin only from a match the text names (core `rankFoundPlaces`).
  It resembles the text (`placeMatch`): the same name; every word
  beginning one of the place's name or address words, one of them its
  own — of its name or street, not of the address parts that say where
  it is (`readAddress`: the first part is its street when it begins with
  the place's name — a city or a street, whose name is its own wherever
  the address repeats it — or holds a house number with a postal code or
  more parts after it), so "Vienna, Austria" is the city and no place
  that stands in it, nor "Mountain View" a past place on Amphitheatre
  Pkwy; or the same Kölner Phonetik key as the name's first words, word
  by word or run together — "Cafe Zentral" as dictated is Café Central,
  "Cafe Meek" Kaffemik. And it is nearby (`isNearby`: within 150 km of
  any of the last 90 days' placed events or of the time zone's city, so
  a trip does not make home far; without such events 2,500 km around the
  zone's city, which says little of where the user is) or the text says
  where it is (`saysWhere`: every word of a part of its address that
  says where, codes such as "NSW" aside — "Hotel Adlon Berlin"; a city
  or street named on its own, "Linz"; never a name that holds its city
  and no more, "Chicago Grill"). A far place the text names is no pin
  for now, never a remembered miss: the region may change; a cached pin
  the rule now refuses gives way to a miss when it is refreshed. A
  picked suggestion is that exact place. `placeCandidates`
  returns the user's own past places the text names first (core
  `rankPastPlaces`: a year of occurrences, matched by the text they were
  written as — a picked "name, address" read as both — MapKit's name or
  sound, one per text, the latest use; a place the user has been to
  counts wherever it is) and then the search's matches not among them
  (`mergePlaceCandidates`; MapKit is asked two ways side by side, the
  natural-language search and the completer's rows resolved; the nearby
  hits that do not resemble the text and one far namesake follow as
  `search`, offered and never taken, and any other far hit is left out),
  best first and uncached. A dictated turn's place goes with
  dictation's other readings of it (ai `alternativesFor`): its words are
  found among the phrase's (local alignment over words, each pair scored
  by edit distance over letters, so a place the model spelled its own
  way word by word or began in an earlier turn still finds the words
  said now; a name split or joined another way does not), each segment
  they stand in is lined up word by word with each of its alternatives,
  and the alternative's words in that span replace them — a word only
  the alternative has joins the span at its edge when the word beyond is
  read the same, and beside a word that changed too the alternative is
  left out rather than searched in part — combined across segments, the
  likeliest first, four at most, never the text again; words said twice
  are read in both places, and words holding fewer than four letters
  ("at", "6") stand for nothing. Only when the text itself names nothing
  nearby (no candidate `preselectedPlace` would take) does the handler
  ask them: the past places each names, then one MapKit search each,
  kept when it resembles its reading and is nearby or where it says,
  within what is left of 4 s since the lookup began (1.5 s at most; none
  left, the past places alone) — a second short of the turn's 5 s, past
  which every candidate would be dropped. Three at most come first,
  marked with their reading (`alternative`), the text's own after them,
  and none is taken unasked. A refine turn looks each place text up
  once, however many drafts it sets it on. The draft thread (app-state `draftPlaces.ts`) asks for them
  whenever a turn sets a place: the best resembling one is taken at once
  (`preselectedPlace`) — its text becomes the location and its pin counts
  as a pick (`applyPlace`) — and the candidates stay on the draft as
  `placeChoice` until answered, skipped, dismissed or a turn sets another
  place: a question when there is a real choice (`isPlaceQuestion`), a
  row with "As said" for a lone taken place, live only while the field
  reads the text or one of them (`livePlaceChoice`). Both lookups and the typeahead carry a region hint
  (`regionHint`: the densest cluster of coordinates on the last 90 days'
  events, the most recent first, else the primary time zone's city from
  a small table), which MapKit takes as a bias, never a filter — a
  strong match elsewhere still wins, which is why the app measures the
  distance itself — and never a location permission. The bridge returns `places` beside
  `place`; a native side from before it answers one place. Desktop
  draws a static `MKMapSnapshotter` PNG (`mapSnapshot`); iOS a live
  `expo-maps` view (without its module, only the links). Both apps' event
  details show the map below its address, then a Get directions group
  with filled Apple Maps and Google Maps buttons (`locationDirectionsUrls`).
  These HTTPS links use
  matching coordinates when known and the address text otherwise, so
  directions remain available while geocoding is pending or fails. The
  Maps app chooses the origin and travel mode; no location permission is
  needed in Solunivo.
- **Device settings and the settings document**: `device_settings` is a
  key/value table for preferences that never sync to Google
  (`birthdayReminders`, `birthdayReminderOverrides` — keyed through
  `birthdayMergeKey`, so an override survives a source coming or going;
  both read values saved before each reminder had its own time through
  `upgradeBirthdayReminderData`, as the settings document does —
  `eventNotifications`, `taskNotifications`, `timeZones`, `viewPreferences`, `onboarding`,
  `newEvents`, `mirrors`, `mirrors.local`, `importedVisibility`,
  `localNotifications.*`), behind
  rpc because the consumer is a backend job in both hosts. The portable
  subset travels in `SettingsDocument` (core): Export/Import on both apps
  and the desktop's watched `~/.solunivo/solunivo.jsonc`, two-way (file →
  app through a directory watch plus a periodic stat; app → file through
  `jsonc-parser` edits so comments survive). An import writes a section
  only where it differs from what the device holds, so a choice equal to
  the default is never stored: when a default flips, such choices read as
  unchosen and the file's write-back rewrites them (Screen Sharing's,
  decisions.md), so a default flip says what it does to them. Accounts
  are a sign-in checklist, never tokens; an import never removes anything and never
  connects an Apple provider; visibility for rows not synced yet is
  parked in `importedVisibility` and applied after each list pass. Of
  `viewPreferences` only `PortableViewPreferences` travels (the lane cap,
  `weekendDays`, `weekendShading`), each field optional and imported
  only when present; the opening view and the sidebar stay on the device.
  `newEvents` is the default calendar (Settings › Calendar): `lastUsed`
  or a calendar named the way mirrors name one (Google by email and id,
  Apple by source and title; `placeDefaultCalendar`, core), compared on
  import by that name, never its title. One this device lacks stays
  stored and named as missing in Settings, and new events take the
  calendar used last until it is here. An editor reads it once as it
  opens (the calendar roots wait for the read): seed, default, last
  used (kept in the window's JS: lost when the Mac's calendar window
  closes), first writable.
- **Settings code**: the settings document as one line a QR code carries,
  for copying a setup between the iPhone and the Mac (core
  `settingsCode.ts`): `SOLUNIVO:1:` + RFC 4648 base32 (no padding) of the
  raw-deflated JSON — base32 stays in the QR alphanumeric set and has no
  space, `%` or `+` for a paste to mangle. What an import never reads is
  left out: Google calendar and list titles (Google matches by id),
  Google titles in mirror refs, the Mac-only `desktop` section; Apple
  titles stay (they are the match keys). A typical three-account setup is
  about a thousand characters, QR version ~22 at error correction M; past
  version 40 the QR gives way to the text alone. The decoder finds a code
  in any text (wrapped, inside a sentence, a lowercased scheme; the prefix
  as written and a document's worth of payload, so a note that starts
  "Solunivo: 2:" stays a note), caps the
  input and the inflated size, says when a newer app made the code, and
  ends in `parseSettingsDocument`, so a code imports exactly as a file
  does. `useSettingsCode` (app-state) rebuilds it from a `settingsDocument`
  atom keyed on `SETTINGS_DOCUMENT_KEYS` (db keys: the ones the watched
  file writes back on — never events or tasks). Shown behind a Show Code
  reveal where it is not asked for (the lesson, the Mac's Settings File
  card): it holds account addresses and calendar choices. Read on iOS
  by expo-camera (started by a tap, only while the screen is in front) or
  a paste field (no "Allow Paste" prompt); on the Mac by the FaceTime
  camera — Electron's Chromium has no `BarcodeDetector`, so the renderer
  sends a JPEG frame a few times a second over `camera:read-qr` and the
  helper reads it with Vision (`barcode.readQr`, `BarcodeReader.swift`) —
  or a paste. A pasted or shared code never reaches the AI capture: ⌘V on
  the Mac's calendar or in the Assistant's field opens the import preview
  (`codeImportRequests.ts`), and on iOS a code shared in, or opened from
  the Camera app's "Open in Solunivo" (it parses as a `solunivo:` URL;
  production only, the dev app owns `solunivo-dev`), waits in
  `settingsCodeInbox.ts` for a reader: the setup's copy step while the
  setup is up or due, else Settings › Read Code. Such a URL moves nothing
  on the router in a running app (`redirectSystemPath` answers null): the
  usual `/` would dismiss the setup whose copy step is waiting for it.
  While the setup is up or a reader is in front, a share's own URL moves
  nothing either (it carries no text), and a capture it starts waits for
  the setup or Settings to close.
- **Time zones**: up to three entries per device, one primary, which
  replaces the device zone for everything the UI draws (both roots gate
  on `useTimeZones()`); the others hang under each hour in the gutter,
  one line each, under a header naming the cities in the same order, and
  a shade per place ties a line to its city (primary `text`, then
  `text-secondary`, then `text-tertiary`: `zoneInk` on the Mac,
  `zoneColor` on iOS; iOS Day view gives the cities a row of their own).
  The inspector or detail sheet and the editor list them one per line
  (`draftZoneRanges`); a tall block joins them on one. One entry is the word `device`: this device's own zone, kept as
  the word and resolved against the OS on every read (`resolveTimeZones`
  over the once-a-minute device zone atom), so the grid follows a flight
  and an exported file reads right on another device. It is always
  present and never removed (a settings file without it fails to parse);
  a fixed zone the device is in right now draws once (`zoneKey` also
  folds UTC's links). The catalog is a checked-in canonical list; a
  device stores the spelling its engine validates (`runtimeZoneId`) and
  displays through `canonicalZoneId`. Both pickers open on the whole
  catalog and narrow it as the user types (`searchTimeZones`, no cap): a
  capped-height dropdown on the Mac, a virtualized list on iOS. Notifications, EventKit's floating
  zone and timed reminders stay on the device zone, read on every pass;
  an event reminder adds the start in the primary zone when that reads
  another clock ("9:00 AM (3:00 PM Vienna)", `planEventReminders`).
- **Local notifications**: `LocalNotifications` (packages/sync) runs its
  own loop — outside the sync pass — over three producers, `loadEventPlans`
  (visible calendars, a week ahead, `useDefault` resolved against the
  calendar's `defaultReminders`, Apple Calendar events only when the
  setting includes them), `loadBirthdayPlans` (one notification per
  reminder — a lead time and its own time of day, one per lead; a
  person's own reminders replace the general ones; the general switch
  gates both) and `loadTaskPlans` (open tasks on visible lists due today
  through a week ahead: a task with a time of its own at that time, any
  other at `taskNotifications.time` on its due day, both on the device's
  clock — a reminder with an instant of its own on that instant's day
  here, since its stored day was written in the zone the device was in
  when the row was last read; Apple Reminders unless switched off; a
  Google task still under
  its temporary id skipped; one per task and due day, key
  `task:<account>/<id>:<dueDate>` (not the list: a move keeps the id; a
  reminder with an instant of its own `…/<id>@<dueUtc>`, which no zone
  change moves),
  `expiresAt` midnight after the due day, no `dismissAt`), merged
  into one `PlannedNotification` list, each carrying a `target` the tap
  resolves (`findNotificationEvent`, `findNotificationTask`). A producer
  whose setting is off returns nothing; the OS schedule is cleared only
  when all do. The
  platform `NotificationSink` delivers: desktop fires an Electron
  `Notification` for what came due since its last pass
  (`localNotifications.lastPass` in `device_settings`, beside the fired
  keys) or whose subject predates its moment (`PlannedNotification.since`:
  the row's `updatedAt`; for tasks and birthdays the later of that and
  the settings row's stamp, with `localNotifications.tasksSince` standing
  in until task notifications are first saved), while the plan's
  `expiresAt` allows — a Mac asleep or closed through the moment catches
  up, a row a pull brings after the pass still shows, a plan whose moment
  was past when its subject came to be (a task created in the afternoon,
  a notify time moved earlier) stays silent as on iOS, and a key fires
  again at a later moment (a reminder postponed); iOS replaces
  the pending expo-notifications schedule with the soonest ≤ 60 whenever
  the digest changes. An event plan also carries `dismissAt` — its end
  (all-day: midnight after the last day on the device's clock), never
  before the grace a missed reminder keeps (`expiresAt`: five minutes
  timed, twelve hours all-day); a birthday none — in the notification
  payload (part of the digest). After the hand-over, every pass, even one
  whose hand-over failed, reads the delivered list back through the
  scheduled sink (`DeliveredNotification`: key, `dismissAt`, `target`)
  and dismisses by the scheduler's rule — an event reminder past its
  `dismissAt`; a task's once the stored task (read by its list, then by
  id alone, since a move keeps the id) is completed, on another day than
  the notification's (a timed reminder: at another instant — a repeating
  reminder checked off advances in place), or gone for a minute
  (`ABSENT_GRACE_MS`: a move from another device lands list by list) — so
  a notification leaves Notification Center at the next pass: the
  foreground loop, a return to the foreground, or the background task
  (with the app closed, that can be hours). The iOS switches "Remove When
  Over" (`EventNotificationSettings.dismissWhenOver`) and, per provider,
  "Remove Tasks / Reminders When Done"
  (`TaskNotificationSettings.dismissTasksWhenDone` /
  `dismissRemindersWhenDone`) skip that step for their kind; the payloads
  keep their data either way. Absent reads as on and stays absent until
  someone flips the switch; a save or import that leaves one out keeps
  the stored value, and an import compares by effect
  (`sameEventNotificationSettings`, `sameTaskNotificationSettings`). The
  Mac has none of these switches (it never removes a notification): it
  stores a value only from an import and passes it on like the other
  fields. The loop sleeps until the next delivery (5 s..60 s) and
  re-plans, debounced, on `EVENTS_KEY` / `BIRTHDAYS_KEY` / `TASKS_KEY` /
  `TASKLISTS_KEY`; a settings
  write is not one of those, so each settings path runs a pass itself
  (a time zone save too: the event text names the primary zone).
  On iOS a background task (`apps/ios/src/backgroundTask.ts`,
  `expo-background-task`, 30-minute minimum) runs `backgroundRefresh`: a
  pull bounded to 20 s, then one notification pass and a budgeted mirror
  pass; Google tokens are stored `AFTER_FIRST_UNLOCK` so that pull can run
  while the phone is locked (`apps/ios/src/tokenStore.ts`). The OS grants the `BGProcessingTask` when it likes; to
  exercise it, call `triggerBackgroundRefreshForTesting` in a debug build
  or the debugger's `_simulateLaunchForTaskWithIdentifier:` on
  `com.expo.modules.backgroundtask.processing` — both inside a running
  app. React Native starts with the app's scene, and the task's own
  launch of a terminated app may connect none: when none has connected
  2 s after launch, `apps/ios/modules/solunivo-background-launch` starts
  the React host without a view (release builds, CI's e2e build included;
  with expo-updates on, after its launch picked the bundle), the
  bundle's evaluation defines the task, and expo-task-manager hands it
  the event it queued. A scene that connects later adds the app's surface
  to that host instead of starting a second runtime; one that connects
  while expo-updates is still launching gets the app from expo-updates'
  handler as usual. Only a device launches an app for the task; the
  simulator cannot.
- **Event reminders** are data on the record (`EventRecord.reminders`,
  Google's `useDefault`/`overrides` shape; `useDefault:false` with no
  overrides is "none", distinct from the field being absent), mirrored
  from Google and from EventKit alarms (`useDefault` always false). A
  PATCH carries the whole object only when the op is flagged
  `remindersChanged`, since Google replaces it and email overrides must
  survive an unrelated edit.
- **The task editor** forks on the selected list's provider
  (`useTaskEditorModel.provider`): Google gets title/day/notes;
  Reminders add time, priority, alert, repeat (shared `useRepeatState`)
  and URL; on both, the list picker moves an existing task on Save
  (`canMoveList`). "Reminder" is a kind of the
  editor's control (core `editor/itemKinds.ts`), not a list choice.
- **Find a time** in the event form (`FindTimeFields`,
  `useFindTimeModel`, both apps) sits beside the date and times: presets
  over the pure solver (core `scheduling/finder.ts`: today / this week /
  next week / 2 weeks; daytime, 08–20 and the solver's default, /
  mornings / afternoons / evenings; any day / weekdays / weekends; a
  duration starting as the form's own), a Search, and the slots as
  buttons — a pick moves the event there (`applySlot`; an all-day series
  keeps its kind, so it has no finder). What the save will move or drop
  is not its own busy time (`rescheduledEventExclusion`, read off
  `updateRecurring`): the row for "This event"; every drawn occurrence
  for "All events", while a stored exception keeps its times and stays
  busy; everything from the split for "This and following"; nothing of a
  series with fixed RDATE dates or a clock-pinning BYHOUR rule (a drawn
  row does not say what placed it, and those stay put through both
  edits), and nothing of a series whose master is not here — an Apple
  series never is, its rows being read through EventKit, so an Apple
  series edit searches around its own occurrences. Too busy is the safe
  side. It works without a model; with one, a phrase fills the same
  presets (Data flow → AI) — dates, hours or days outside them show as a
  note with nothing selected — and a title it names fills an empty title.
  An answer landing after a constraint changed or the finder closed is
  dropped.
- **Time is Temporal everywhere** (`@js-temporal/polyfill` via
  `packages/core/src/time/temporal.ts`); Hermes needs the
  `Intl.resolvedOptions` shim in `packages/core/src/time/intl-compat.ts`.
