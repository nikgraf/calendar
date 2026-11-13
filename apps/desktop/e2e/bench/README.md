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
| `MODEL_BENCH_PIPELINE` | What runs around the model, comma-separated: `app` (the default), `raw`, `plain`, `tuned`. See Arms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MODEL_BENCH_CASES`    | Only the cases whose id contains a term or whose tags hold it (`flow,de`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MODEL_BENCH_STT`      | `off`: every recording's transcript is parsed, nothing is transcribed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL_BENCH_COMPARE`  | An earlier report (JSON) to print the difference to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MODEL_BENCH_RESCORE`  | Earlier reports (files, or a folder of them, comma-separated) scored again by the checks as they are now, without asking any model; each is written as a new report that names the run it came from, in its file name too. A recorded turn's "the transcript passes" is scored again where the report kept the transcript's outcome, and left out where it did not. A case that is gone, or has other turns or words than the model answered, stays as the report had it and is named. For a change to the checks or to an expectation alone; a changed address book or recording needs a run.                                                                                                                                                                                     |
| `MODEL_BENCH_OUT`      | Where reports go; default `output/bench/` (gitignored).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Arms

A model is one half of a result; what runs around it is the other.
`MODEL_BENCH_PIPELINE` lists the arms to run, each a report of its own
(`apple`, `apple+raw`, `apple+plain`):

- `app`: the app's pipeline, as the thread runs it. The grounding holds
  every answer against the words.
- `raw`: the app's prompts, and the model's answer as it came: validated,
  never held against the words (`raw.ts`). Beside `app` it says what the
  grounding buys on a model. It is not what a model can do on its own:
  the app's prompts and schema leave to code the to-do cue, the people,
  notes and notifications, a meal's time and a repeat's weekdays, and
  `raw` has none of that code. On the 70 cases of 2026-11-11, 32 need one
  of these, so 38 is the most `raw` can score.
- `plain`: one prompt per turn that states the product's conventions in
  prose and asks for the whole draft; the code after it checks shapes,
  fills a form's defaults and holds a repeat to the editor's rules (it
  starts on a day of its rule, an end that has passed is next year's),
  and never reads the phrase (`plain.ts`). It is what a capable model
  does on its own. Apple's model cannot follow it.
- `tuned`: the plain arm for a model trained on its answers. The prompt
  is the days, the draft and the words, without the conventions; the
  code after it is the plain arm's (`tuned.ts`). It asks with no schema:
  the model learnt to write a draft short, and the strict schema would
  have a server write every field. A day it cannot look up in the days
  it is shown, and a repeat with a weekday ruled out, it writes as they
  were said ("14", "03-14", "+2w"; `except` beside the rule), and code
  that reads no phrase works them out (`said.ts`): which year a date
  falls in is arithmetic, and a small model is poor at it. A model that
  was not trained for it has nothing to go by. Data, training and
  serving: `train/README.md`.

The cases were written beside the grounding they test, so `app` is
flattered by them: a tie between `app` and another arm is a result for
the other arm.

### Local models

Open models run through Ollama's OpenAI-compatible endpoint, so they get
the strict schema, with thinking switched off (a reasoning model answers
in a second instead of twenty, and the smallest never stops thinking):

```bash
MODEL_BENCH=1 E2E=1 MODEL_BENCH_APPLE=0 MODEL_BENCH_PIPELINE=app,raw,plain MODEL_BENCH_OPENAI_URL=http://127.0.0.1:11434/v1 MODEL_BENCH_OPENAI_EXTRA='{"reasoning_effort":"none"}' MODEL_BENCH_OPENAI=gemma4:e2b-it-q4_K_M,qwen3.5:2b-q4_K_M,lfm3:1.7b-q4_K_M pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

`MODEL_BENCH_OLLAMA` asks Ollama the way the app's own setting does (the
schema as `format`, optional fields, thinking as the model defaults).
Constrained answers have no length limit on a text field: a model that
believes it is done can go on inside the last string ("Dinner with Teo…
Correction: the prompt asks for JSON"), and which field comes last
changes how often.

## Cases

One file per case under `cases/`, a list of turns. The first turn is a
phrase (`parseQuickAdd`), every later one a change to the draft it left
(`parseRefine`), as the thread does. In the `app` arm the grounding runs
on every answer, as in the app, so the table measures the whole
pipeline; the report keeps the raw model answers per turn for telling
the model's errors from the grounding's.

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
  expectation names one. The app's pipeline cannot invent these; a model
  taken at its word (`raw`, `plain`) can, and "at nichts, every year" is
  not the event that was said. A first phrase that is refused fails it
  with every other field.
- Every turn after the first is also held to the **unchanged rule**: each
  part of the draft the expectation is not about must read as it did
  before the turn. A change that moves the time and leaves the title
  alone states the times; if the title moved too, that is a failure.
  Times and all-day-ness are one part.
- `lang` picks the recogniser's locale (`en-US`, `de-DE`; `locale`
  overrides) and `contacts` the address book in `contacts.json` (default
  `team`) names are looked up in, every match, as the thread does.
- In the `app` arm notes and notifications are what the words added
  (`readExtras` in `@calendar/ai`), folded into the draft as the thread
  does it: a note joins the notes on its own line, offsets join the
  notifications. `plain` takes them from the model's answer; `raw` has
  none.

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
that flipped and the fields that moved, and says when the two runs were
not set up alike (a served model's endpoint and extra request body, the
report's `settings`).

## Recordings

`audio/README.md` lists the clips the cases ask for and how to record
them. Only the Mac's helper transcribes, but SpeechAnalyzer is the
framework iOS dictates with, so the Mac stands in for both platforms.
