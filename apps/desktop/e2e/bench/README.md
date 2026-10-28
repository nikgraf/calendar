# Model bench

The quick-add and refine pipelines on real models, side by side, scored
by where a person would put the event. Measured, never gated: it prints
a table, writes a report and passes. Never part of `pnpm test` or the
e2e suite — it skips itself unless `MODEL_BENCH=1`.

```bash
MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

| Variable              | What it does                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODEL_BENCH_HELPER`  | The desktop helper binary; default the package's own `helper/.build/release` build (`pnpm --filter @calendar/desktop build:helper`). `MODEL_BENCH_APPLE=0` leaves Apple's model out. |
| `MODEL_BENCH_OLLAMA`  | Ollama models, comma-separated (`gemma3:4b,gemma3:12b`); `MODEL_BENCH_OLLAMA_URL` the server (`http://localhost:11434`).                                                             |
| `MODEL_BENCH_OPENAI`  | A model behind an OpenAI-compatible endpoint; `MODEL_BENCH_OPENAI_URL` the base up to `/v1` (`http://localhost:1234/v1`), `MODEL_BENCH_OPENAI_KEY` its key.                          |
| `MODEL_BENCH_CASES`   | Only the cases whose id contains a term or whose tags hold it (`flow,de`).                                                                                                           |
| `MODEL_BENCH_STT`     | `off`: every recording's transcript is parsed, nothing is transcribed.                                                                                                               |
| `MODEL_BENCH_COMPARE` | An earlier report (JSON) to print the difference to.                                                                                                                                 |
| `MODEL_BENCH_OUT`     | Where reports go; default `output/bench/` (gitignored).                                                                                                                              |

## Cases

One file per case under `cases/`, a list of turns. The first turn is a
phrase (`parseQuickAdd`), every later one a change to the draft it left
(`parseRefine`), as the thread does. The grounding runs on every answer,
as in the app, so the table measures the whole pipeline; the report
keeps the raw model answers per turn for telling the model's errors from
the grounding's.

```json
{
  "lang": "en",
  "tags": ["flow", "guests"],
  "turns": [
    {
      "input": { "text": "Dinner with Teo next Friday" },
      "expect": {
        "title": "dinner with teo",
        "weekday": 5,
        "startTime": "19:00",
        "endTime": "20:00"
      }
    },
    {
      "input": { "audio": "flow-dinner-2.m4a", "transcript": "make it 8" },
      "expect": { "startTime": "20:00", "endTime": "21:00" }
    }
  ]
}
```

- `input` is `{ "text" }`, or `{ "audio", "transcript" }`: a file under
  `audio/` and what it says, word for word. The recording goes through
  the helper's SpeechAnalyzer; the transcript gives the word error rate,
  and when the recogniser erred and the turn failed, the transcript is
  parsed too, so the table says whether the words as said would have
  passed. A missing file runs as its transcript (`audio: "missing"` in
  the report).
- `expect` says where a person would put it — never a literal date, the
  bench runs on "today". `weekday` (ISO, 1 Monday) or `dayOffset` (0
  today); `startTime`/`endTime` as `HH:MM` (a task has only a start);
  `isAllDay`; `assumedTime` (the times came from a meal or part of the
  day); `kind` (`event`/`task`; the first turn is an event unless it
  says `task`); `title` (whole, compared folded: case,
  accents, ß; a list names several a person would accept) or
  `titleIncludes`; `location` (folded part, or `null` for
  none); `repeat` (`freq`, `interval`, `count`, `untilMonth`, `byDay` as
  weekday codes for a weekly rule, or `null`);
  `guests` (`emails` after the turn and `choices` still to pick from,
  both as sets, absent meaning none); `notes` (folded part); `reminders`
  (minutes before, any order); `rejected: true` when the turn must be
  refused.
- Every turn after the first is also held to the **unchanged rule**: each
  part of the draft the expectation is not about must read as it did
  before the turn. A change that moves the time and leaves the title
  alone states the times; if the title moved too, that is a failure.
  Times and all-day-ness are one part.
- `lang` picks the recogniser's locale (`en-US`, `de-DE`; `locale`
  overrides) and `contacts` the address book in `contacts.json` (default
  `team`) names are looked up in, every match, as the thread does.
- Notes and notifications: no turn fills them yet. The cases that name
  them (`notes`, `notifications` tags) measure that gap.

`contacts.json` holds the fixture address books: made-up people with
`@example.com` addresses, including two Annas (a name that is a choice)
and a Max with two addresses (a choice too).

## Report

`output/bench/<yyyymmdd-hhmm>-<sha>-<provider>.json`: every turn's
input, what was heard, the model calls (prompt and raw answer), the
draft or rejection, the fields checked and failed. The table prints
cases, turns, each field's pass rate, the median time per turn and, for
the recorded turns, how many were transcribed (with the mean word error
rate), ran as their transcript for want of a file or because the
recogniser could not read it, or were skipped. A prompt or grounding change is judged by two runs
on two commits: `MODEL_BENCH_COMPARE=<earlier report>` prints the cases
that flipped and the fields that moved.

## Recordings

`audio/README.md` lists the clips the cases ask for and how to record
them. Only the Mac's helper transcribes, but SpeechAnalyzer is the
framework iOS dictates with, so the Mac stands in for both platforms.
