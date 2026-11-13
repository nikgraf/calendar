# Model bench

The quick-add and refine pipelines on real models, side by side, scored
by where a person would put the event. Measured, never gated: it prints
a table, writes a report and passes. Never part of `pnpm test` or the
e2e suite — it skips itself unless `MODEL_BENCH=1`.

```bash
MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

| Variable               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_BENCH_HELPER`   | The desktop helper binary; default the package's own `helper/.build/release` build (`pnpm --filter @calendar/desktop build:helper`). `MODEL_BENCH_APPLE=0` leaves Apple's model out; `MODEL_BENCH_APPLE_REQUIRED=1` adds it a second time as `apple-required`, asked for every field (empty where the words give nothing): asked with optional fields it answers a first phrase with the title alone.                                                                                                                                                                                                                                                                                                                                                                              |
| `MODEL_BENCH_OLLAMA`   | Ollama models, comma-separated (`gemma3:4b,gemma3:12b`); `MODEL_BENCH_OLLAMA_URL` the server (`http://localhost:11434`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MODEL_BENCH_OPENAI`   | Models behind an OpenAI-compatible endpoint, comma-separated; `MODEL_BENCH_OPENAI_URL` the base up to `/v1` (`http://localhost:1234/v1`; Ollama's is `http://localhost:11434/v1`), `MODEL_BENCH_OPENAI_KEY` its key, `MODEL_BENCH_OPENAI_EXTRA` JSON joined to every request body (`{"reasoning_effort":"none"}` stops a reasoning model thinking aloud on Ollama); it may not name the model, the messages or the response format, and the report keeps it with the endpoint (`settings`). This path sends the strict schema: every field required, an optional one nullable. `MODEL_BENCH_OPENAI_JSON=object` is for a server with JSON mode only (DeepSeek's API): the schema then goes into the prompt; a busy server (429, 5xx) and a blank JSON-mode answer are asked again. |
| `MODEL_BENCH_PIPELINE` | What runs around the model, comma-separated: `tuned` (the default), `plain`. See Arms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL_BENCH_CASES`    | Only the cases whose id contains a term or whose tags hold it (`flow,de`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MODEL_BENCH_STT`      | `off`: every recording's transcript is parsed, nothing is transcribed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL_BENCH_COMPARE`  | An earlier report (JSON) to print the difference to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MODEL_BENCH_RESCORE`  | Earlier reports (files, or a folder of them, comma-separated) scored again by the checks as they are now, without asking any model; each is written as a new report that names the run it came from, in its file name too. A recorded turn's "the transcript passes" is scored again where the report kept the transcript's outcome, and left out where it did not. A case that is gone, or has other turns or words than the model answered, stays as the report had it and is named. For a change to the checks or to an expectation alone; a changed address book or recording needs a run.                                                                                                                                                                                     |
| `MODEL_BENCH_OUT`      | Where reports go; default `output/bench/` (gitignored).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Arms

A model is one half of a result; what runs around it is the other.
`MODEL_BENCH_PIPELINE` lists the arms to run, each a report of its own
(`openai:<model>+tuned`, `openai:<model>+plain`):

- `tuned`: the app's own code (`@calendar/ai`, `tunedTurn`), for a model
  trained on its answers: the Assistant's model on both apps. The prompt
  is the days, the draft and the words; the code after it checks shapes,
  fills a form's defaults and holds a repeat to the editor's rules, and
  never reads the phrase. It asks with no schema: the model learnt to
  write a draft short, and the strict schema would have a server write
  every field. A day it cannot look up in the days it is shown, and a
  repeat with a weekday ruled out, it writes as they were said ("14",
  "03-14", "+2w"; `except` beside the rule), and code that reads no
  phrase works them out (`said.ts`). A model that was not trained for it
  has nothing to go by. Data, training and serving: `train/README.md`.
- `plain`: one prompt per turn that states the product's conventions in
  prose and asks for the whole draft, the same code after it
  (`plain.ts`). It is what a capable general model does on its own, and
  the arm the training data's teacher answers.

The app's former arms (`app`: the rules pipeline over Apple's or a
served model; `raw`: its prompts without the rules) left with the rules
(2026-11-13, #307); their reports stay comparable by name.

### Local models

The Assistant's file runs on the `llama-server` the Mac app bundles
(`pnpm --filter @calendar/desktop build:llama`), asked the way the app
asks it:

```bash
apps/desktop/llama/.build/llama-server -m solunivo-assistant-q8_0.gguf -c 4096 -np 1 -ngl 99 --port 8090 --offline --reasoning off
MODEL_BENCH=1 E2E=1 MODEL_BENCH_APPLE=0 MODEL_BENCH_OPENAI_URL=http://127.0.0.1:8090/v1 MODEL_BENCH_OPENAI=assistant-v1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

General models on the plain arm run through Ollama's OpenAI-compatible
endpoint, so they get the strict schema, with thinking switched off (a
reasoning model answers in a second instead of twenty, and the smallest
never stops thinking):

```bash
MODEL_BENCH=1 E2E=1 MODEL_BENCH_APPLE=0 MODEL_BENCH_PIPELINE=plain MODEL_BENCH_OPENAI_URL=http://127.0.0.1:11434/v1 MODEL_BENCH_OPENAI_EXTRA='{"reasoning_effort":"none"}' MODEL_BENCH_OPENAI=gemma4:e2b-it-q4_K_M,qwen3.5:2b-q4_K_M pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

`MODEL_BENCH_OLLAMA` asks Ollama the way the app's own setting does (the
schema as `format`, optional fields, thinking as the model defaults).
Constrained answers have no length limit on a text field: a model that
believes it is done can go on inside the last string ("Dinner with Teo…
Correction: the prompt asks for JSON"), and which field comes last
changes how often.

## Cases

One file per case under `cases/`, a list of turns. The first turn is a
phrase, every later one a change to the draft it left, as the Assistant's
thread does. The report keeps the raw model answers per turn.

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
  none) or `locationIs` (whole, folded: a turn that must not keep what
  was there); `repeat` (`freq`, `interval`, `count`, `untilMonth`, `byDay` as
  weekday codes for a weekly rule, or `null`);
  `guests` (`emails` after the turn and `choices` still to pick from,
  both as sets, absent meaning none); `notes` (folded part); `reminders`
  (minutes before, any order); `rejected: true` when the turn must be
  refused.
- The first turn is also held to the **unsaid rule**: a place, a repeat,
  guests, a note or a notification is in the draft only where the
  expectation names one. A model taken at its word can invent these,
  and "at nichts, every year" is not the event that was said. A first phrase that is refused fails it
  with every other field.
- Every turn after the first is also held to the **unchanged rule**: each
  part of the draft the expectation is not about must read as it did
  before the turn. A change that moves the time and leaves the title
  alone states the times; if the title moved too, that is a failure.
  Times and all-day-ness are one part.
- `lang` picks the recogniser's locale (`en-US`, `de-DE`; `locale`
  overrides) and `contacts` the address book in `contacts.json` (default
  `team`) names are looked up in, every match, as the thread does.
- Notes and notifications are what the model's answer says, folded
  into the draft as the thread does it.

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
recogniser could not read it, or were skipped. A prompt, data or model change is judged by two runs
on two commits: `MODEL_BENCH_COMPARE=<earlier report>` prints the cases
that flipped and the fields that moved, and says when the two runs were
not set up alike (a served model's endpoint and extra request body, the
report's `settings`).

## Finder bench

Find a time reads a sentence ("find 90 min for focus next week,
mornings", "wann habe ich morgen Nachmittag eine Stunde Zeit?") into
the constraints the solver searches with. `finderBench.e2e.ts` runs the
cases in `finder.json` through the app's finder prompt and schema on the
same models (the MODEL_BENCH_* variables above), and reads each answer
two ways:

- `rules`: as the app does today, held to the words by the code
  (`normalizeFindTime` given the phrase, `grounding.ts`), the finder's
  own length where the words say none;
- `raw`: the model's answer without the word rules (`normalizeFindTime`
  without the phrase), what a model has to get right once the rules go.
  The code's defaults still fill what the model leaves out (the coming
  week for a window, as the prompt asks), and a case whose words give no
  length passes any: the schema has the model write one.

```bash
MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/finderBench.e2e.ts
```

A case states every part a person means (`finder.ts` says how):
the length (`"default"`: the finder's own, 60), the window by its name
(`"nextWeek"`, `{ "weekday": 4 }`, …, so a case holds on any day), the
weekdays, the daily bounds (a meal's or a part of the day's window by
name, or clock times) and what the time is for. The window and the
weekdays are scored together, as the dates searched: the coming
Wednesday and the coming week on Wednesdays are the same search. The
bounds are scored as the solver searches them, its own 08:00–20:00 where
one end is not set, and only the dates from today on (the solver offers
no slot in the past). Each report says what an empty answer scores: the
floor the code's defaults give, 8 of 40 with the rules on most days.
`MODEL_BENCH_CASES` picks cases by language ("de", "en") or id part. The
report, `output/bench/finder/finder-<yyyymmdd-hhmm>-<sha>-<provider>.json`,
keeps each prompt and answer as the model got and gave them, and each
arm's parts with what they read. `MODEL_BENCH_RESCORE=<report or folder>`
scores stored answers again by the cases and code as they are now.

## Recordings

`audio/README.md` lists the clips the cases ask for and how to record
them. Only the Mac's helper transcribes, but SpeechAnalyzer is the
framework iOS dictates with, so the Mac stands in for both platforms.
