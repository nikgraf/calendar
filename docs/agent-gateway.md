# Agent gateway

Other agents on the same Mac (Hermes, OpenClaw, a script) can read and
change calendars and tasks through the running desktop app — over MCP or
a CLI — with a per-agent grant the user sets in Settings → Agents.

Why go through the app instead of an agent's own Google integration:
everything is already connected (several Google accounts, Apple Calendar,
Reminders), writes get the op queue, conflict handling and recurrence
logic, and the app can scope access per calendar, which Google's OAuth
scopes cannot.

## Shape

```
agent ──stdio──▶ solunivo-cli (relay, no logic) ──unix socket──▶ Electron main
                                                    ├─ MCP server (@modelcontextprotocol/server)
                                                    ├─ CLI runner (same tools, argv in → JSON out)
                                                    └─ gateway (@calendar/agent):
                                                       auth → resolve → policy → approval → audit
                                                       → EventMutations / repos
```

- **`packages/agent`** — everything that decides: the policy
  (`policy.ts`), refs (`refs.ts`), the tool contract (`contract.ts`), the
  enforced reads and write plans (`ops/`), target resolution
  (`resolve.ts`), approvals and the single entry point `callTool`
  (`gateway.ts`), the store (`store.ts`) and what the Settings UI calls
  (`manage.ts`).
- **`apps/desktop/electron/agent/`** — the host: `agentHost.ts` (runtime,
  socket lifecycle, `agents:*` IPC, notification + Dock badge),
  `socketServer.ts` (node:net), `mcp.ts`, `cliRunner.ts`, `protocol.ts`
  (shared with the relay).
- **`apps/desktop/electron/cli.ts`** — the relay, bundled on its own as
  `dist-electron/cli.mjs` (node built-ins only, ~6 kB). In the packaged
  app `Contents/Resources/solunivo-cli` runs it with the app's own binary
  (`ELECTRON_RUN_AS_NODE=1`), so no Node install is needed.

The backend has no caller identity and no permission checks below the UI
(`createEvent` does not even check a read-only calendar), so the gateway
enforces everything itself and is the **only** entry for agents.

## Tools

`list_calendars`, `list_task_lists`, `list_events`, `get_free_busy`,
`find_free_slots`, `create_event`, `update_event`, `delete_event`,
`respond_to_event`, `list_tasks`, `create_task`, `update_task` (includes
complete/reopen), `delete_task`, `search_contacts`, `get_request`.

Deliberately absent: moving items between calendars or lists,
conversions, accounts, settings, conflicts, the pending-op queue.

- Items are addressed by one opaque **`ref`** carrying the full key
  (calendar ids are unique only within an account; an occurrence needs its
  master and slot). Occurrence writes take a `scope`
  (`instance` | `following` | `series`) and are routed by the record's
  `recurringEventId`/`originalStartUtc`, never by parsing an id.
- Timed events are ISO 8601 (`start`/`end`); all-day events are
  `startDate`/`endDate` with an **inclusive** last day (stored exclusive).
- Inputs are decoded by the same Effect Schemas the advertised JSON Schema
  is generated from (`toolInputJsonSchema`); unknown properties are
  errors.
- CLI: `solunivo-cli <tool> [--flag value …]` or `--args '<json>'`; flags
  are derived from the schema. `solunivo-cli tools` prints the schemas.
  Exit codes: 0 ok, 1 refused/failed, 2 usage or invalid input, 3 unknown
  token.

## Permissions

A grant (`AgentPolicy`) is a default level plus overrides per calendar and
per task list, a guests capability and a contacts switch. New agents start
with nothing.

| Level                  | Reads                                | Writes                       |
| ---------------------- | ------------------------------------ | ---------------------------- |
| `none`                 | invisible; a ref into it is NotFound | NotFound                     |
| `freeBusy` (calendars) | merged busy blocks, no ids or titles | PermissionDenied             |
| `read`                 | full details                         | PermissionDenied             |
| `ask`                  | full details                         | wait for approval in the app |
| `write`                | full details                         | executed                     |

- **`none` answers exactly like "does not exist"** — a denial would
  confirm a hidden calendar or event is there.
- **Hidden in the app = `none` for agents.** Range reads only return
  visible calendars and lists, so a grant never shows more than the UI.
- **Provider read-only** calendars and lists are never writable, whatever
  the grant.
- **Guests** (`off` | `ask` | `allow`): creating, editing or deleting an
  event that has or gains other attendees needs it on top of the calendar
  level — Google emails them, which is the one write an agent could leak
  data with. An RSVP only needs the calendar level. For a `series` or
  `following` write "the event" is everything the scope touches
  (`reachOf` in `ops/events.ts`): the master and every exception it
  rewrites or cancels, so a guest on one later occurrence counts. (Apple:
  the exceptions EventKit returns within ±400 days of the slot.)
- Free/busy merges blocks across calendars and skips all-day, cancelled
  and declined events (there is no `transparency` field yet, so a "free"
  timed event still blocks).
- A field the provider cannot hold still fails with
  `UnsupportedForProviderError` (as `Unsupported`), never silently.

### Resolving the real container

EventKit and Reminders address an item **by id alone** and ignore the
calendar or list a caller names
(`packages/sync/src/appleEventMutations.ts`, `reminderMutations.ts`).
`resolve.ts` therefore finds where the item really lives before the
policy is asked: EventKit's `series` answer for Apple events, the
calendar-keyed row for Google events, the mirror row for tasks. A ref
that pairs a granted calendar with another calendar's event does not
resolve. `moveToListId` is never exposed.

An occurrence ref must name a real occurrence. Google: a stored
exception at that slot, or a slot the rule produces (`assembleWindow`);
a cancelled exception is a deleted occurrence. Apple: the occurrence is
looked up in EventKit around its slot (±45 days), so one that was moved
or renamed on its own is edited — and summarized — as it is now. A
made-up slot is NotFound; a write can neither invent an exception nor
answer "done" for nothing.

A change with scope `series` or `following` starts from the occurrence's
**slot**, not from a moved exception's own times (the series mutation
shifts by the distance from the slot). An all-day series only moves one
occurrence at a time; a series-wide date change is refused rather than
silently dropped. The Reminders mirror can lag Reminders.app by a
moment, so a reminder moved there is briefly judged by its old list.

### Ask first

1. The write is planned (resolved, checked) and stored as a `pending`
   request with a summary **the app wrote**.
2. Main shows an OS notification, badges the Dock icon and pushes
   `agents:changed`; the window shows the approval dialog (a click on the
   notification opens a window when there is none).
3. The agent's call waits ~25 s, then returns
   `{status: "pending_approval", requestId}`; `get_request` polls.
4. Approve is a conditional `pending → approved` transition (two clicks
   execute once). The write is **planned again from the stored input**, so
   a narrowed grant, a removed agent or a moved item still stops it.

5. **An approval covers a description, not an input.** The replay is
   planned again and runs only if it produces the very summary the user
   approved (`sameSummary`). If the event was renamed, moved or gained
   guests in between — by anyone, the same agent included — the request
   fails with "changed after it was asked" and nothing is written.

The summary is built from the event that is **written**, which for a
`series` or `following` change is the master, not the occurrence the ref
names (an occurrence edited on its own can carry other text). Guests a
write reaches are listed by address, never as a count — replacing one
guest with another must change the summary.

The summary is therefore the whole write: nothing in it is shortened
(every guest, the full notes; the dialog scrolls), an update that adds
guests also shows the location and notes those guests will receive, and
line breaks in agent or invitation text are shown as `⏎` so they cannot
pose as another line. Input sizes are capped instead (`ops/limits.ts`:
title 500, location 1000, notes 8000, 100 guests, 10 recurrence lines);
guest addresses must be printable ASCII. Agent text that would draw as
nothing is refused, not stripped (`hiddenCharacter`): control characters
other than line breaks and tabs, and every default-ignorable code point —
tag characters can spell a whole sentence invisibly, which the user would
approve unseen and Google would mail to the guests. A zero-width joiner or
variation selector is allowed only inside a complete emoji (`\p{RGI_Emoji}`:
a family, a flag, a keycap): between pictographs that form no emoji it
draws as nothing, and its presence or absence can spell bits. The summary
keeps those complete emoji whole, so it shows the one family emoji the
write holds.

Identical pending requests are joined, 10 may wait per agent, and a
request can be answered for 24 h (checked when it is answered, not only
by the hourly sweep). The dialog's buttons arm 700 ms after a request
appears, so a double click on one request cannot approve the next. Approval is only ever given in the app —
never through MCP elicitation, which the agent's own client could answer.

## Transport

- Unix domain socket, `~/.solunivo/run/agent.sock` (packaged) or
  `agent-dev.sock` (dev), directory 0700, socket 0600 (created under a
  umask, so there is no window before a chmod). `CALENDAR_AGENT_SOCKET`
  overrides it; **the e2e harness always points it under its temp
  profile**.
- The installed app and a run from source are two gateways that can run
  at once: separate sockets, separate `agents.db` (so separate agents,
  tokens and grants), and the copyable MCP entry is named `solunivo` in
  the packaged app and `solunivo-dev` in a dev build, so one agent's
  configuration can hold both. The relay picks its socket the same way:
  the bundled wrapper sets `SOLUNIVO_CLI_BUNDLE` and gets `agent.sock`,
  `node dist-electron/cli.mjs` gets `agent-dev.sock`.
- It listens only while at least one agent exists.
- First line: `{v, token, mode: "mcp" | "cli", argv?}` → `{ok}`. Then MCP's
  own ndjson, or one `{exitCode, stdout, stderr}` line.
- The token comes from `SOLUNIVO_AGENT_TOKEN` only (never argv, never
  logged). The agent is looked up on **every call**, so a changed grant
  or replaced token applies to an open connection; removing an agent
  drops its connections.
- Limits: 64 KiB hello within 5 s, 1 MiB per MCP message, 32
  connections (8 per agent), 120 calls a minute per agent, 400-day
  ranges, 2000 events. A refused or finished connection is destroyed,
  not just ended — a peer that keeps its half open must not hold a slot —
  and an MCP session that closes itself (an oversize message) takes its
  socket with it.
- MCP: 2026-07-28 (stateless, `server/discover`) with the 2025 `initialize`
  handshake still served (`legacy: 'serve'`).
- If the socket is missing and the relay runs from a `.app`, it starts the
  app with `open -g -a <bundle> --args --background` (never by exec'ing
  the binary — the app must not inherit `ELECTRON_RUN_AS_NODE`) and waits.

## Storage

`userData/agents.db`, desktop-only, with its own migrations
(`runMigrationsWith`). Not `calendar.db`: the phone never has agents, and
grants must not travel with anything that syncs or exports.

- `agents`: name, policy JSON, **SHA-256 of the token**, timestamps. The
  token is 256 random bits with a `sol_` prefix, shown once.
- `agent_requests`: the approval queue and the activity log in one —
  every write attempt with agent, tool, summary, status (`pending`,
  `approved`, `done`, `failed`, `denied`, `expired`, `blocked`), result or
  error. A row keeps the tool input only while it can still be replayed
  (`pending`/`approved`); the log is summaries. The newest 500 finished
  rows are kept and, counted apart, the newest 100 refusals, so a burst
  of refused calls cannot push real writes out (the Settings list gives
  refusals their own small share for the same reason).

Grants are managed over plain preload IPC (`agents:*`), never the rpc
seam, and are never part of `SettingsDocument`: the watched settings file
cannot create an agent or widen one.

## Threat model

The gateway is a **guardrail for agents that connect through it** — a
confused or prompt-injected agent, or one the user wants to keep narrow.
It is not a sandbox: any process running as the user can read
`calendar.db` directly. That is also why the token hash sits in SQLite
rather than behind safeStorage.

- Event and task text is attacker-controlled (anyone can send an
  invitation). Tool descriptions say so; the guests capability closes the
  obvious way out.
- Read access to one calendar plus write access to a _shared_ one is
  still a path for data to leave. The grant is the user's call.
- A calendar mirror (Settings → Mirrors) is such a path by design: an
  agent's write into a calendar that is a mirror's source reaches the
  mirror's destination — reduced to the mirror's allow-list — on the next
  run, without any further approval. The approval summary describes the
  write the agent asked for; where it is copied is the user's standing
  choice. A mirror's copies are never visible to agents (hidden from every
  shared read), and an agent granted the destination can see and change
  them like any event there.
- The relay needs the RunAsNode fuse enabled. A Swift relay would allow
  flipping it (see todo.md).

## Tests

- `packages/agent/src/*.test.ts` — policy matrix, refs, times, DTO
  redaction, store, and `gateway.test.ts` over a seeded world with the
  Apple Calendar and Reminders fakes (forged refs, provider read-only,
  guests, occurrence routing, approvals incl. double approve, narrowed
  grant, removed agent).
- `apps/desktop/electron/agent/*.test.ts` — socket server on a real
  socket (modes, chunking, limits, stale file), MCP against the official
  client in both eras, CLI flag parsing.
- `apps/desktop/e2e/agentGateway.e2e.ts` — the real relay spawned against
  the launched app: CLI and MCP reads, a permitted write, refusals, the
  approval dialog, and Settings → Agents.
- CI runs `solunivo-cli --version` from the packaged and from the signed
  app (the hardened-runtime check).
