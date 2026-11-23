# Model bench

The Assistant's phrases and follow-up turns on real models, side by side, scored
by where a person would put the event. Measured, never gated: it prints
a table, writes a report and passes. Never part of `pnpm test` or the
e2e suite — it skips itself unless `MODEL_BENCH=1`.

```bash
MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

Set the variables inline or `export` them: a bench whose `MODEL_BENCH`
is not "1" skips itself without a word (`docs/platform-notes.md` → Shell
and tooling, on zsh).

| Variable               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_BENCH_HELPER`   | The desktop helper binary; default the package's own `helper/.build/release` build (`pnpm --filter @calendar/desktop build:helper`). `MODEL_BENCH_APPLE=0` leaves Apple's model out; `MODEL_BENCH_APPLE_REQUIRED=1` adds it a second time as `apple-required`, asked for every field (empty where the words give nothing): asked with optional fields it answers a first phrase with the title alone.                                                                                                                                                                                                                                                                                                                                                                              |
| `MODEL_BENCH_OLLAMA`   | Ollama models, comma-separated (`gemma3:4b,gemma3:12b`); `MODEL_BENCH_OLLAMA_URL` the server (`http://localhost:11434`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MODEL_BENCH_OPENAI`   | Models behind an OpenAI-compatible endpoint, comma-separated; `MODEL_BENCH_OPENAI_URL` the base up to `/v1` (`http://localhost:1234/v1`; Ollama's is `http://localhost:11434/v1`), `MODEL_BENCH_OPENAI_KEY` its key, `MODEL_BENCH_OPENAI_EXTRA` JSON joined to every request body (`{"reasoning_effort":"none"}` stops a reasoning model thinking aloud on Ollama); it may not name the model, the messages or the response format, and the report keeps it with the endpoint (`settings`). This path sends the strict schema: every field required, an optional one nullable. `MODEL_BENCH_OPENAI_JSON=object` is for a server with JSON mode only (DeepSeek's API): the schema then goes into the prompt; a busy server (429, 5xx) and a blank JSON-mode answer are asked again. |
| `MODEL_BENCH_PIPELINE` | What runs around the model, comma-separated: `tuned` (the default), `plain`. See Arms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL_BENCH_CASES`    | Only the cases whose id contains a term or whose tags hold it (`flow,de`). A selection leaves the blind cases out: a run of a few cases would give a blind one's outcome away by its counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MODEL_BENCH_STT`      | `off`: every recording's transcript is parsed, nothing is transcribed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL_BENCH_COMPARE`  | An earlier report (JSON) to print the difference to: the cases that flipped, the fields that moved, and how often chance alone would flip as many cases one way. A run of several models or arms compares each with its own earlier report; a run of one model on one arm (`MODEL_BENCH_APPLE=0`, one pipeline) compares it with whatever report is named, another model's too (v2 beside v3).                                                                                                                                                                                                                                                                                                                                                                                     |
| `MODEL_BENCH_BLIND`    | `show`: the blind cases are printed like the open ones. For fixing an expectation, never while briefs or prompts are written (see Blind cases).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MODEL_BENCH_TODAY`    | The day the run reads its phrases on (`YYYY-MM-DD`); default the clock's. What "this week" and "Friday" mean moves with the day, so two runs are compared on one day: name the earlier run's (its report's `today`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
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

The bundled server is the llama.cpp the phone runs: all 70 answers of
each published file (Q4_K_M and Q8_0) on an iPhone 16 matched the same
file's on the Mac, so the Mac's score of a GGUF stands for the phone's.
Apple's model is the opposite: its Mac and iPhone versions answer
differently (`docs/platform-notes.md` → On-device models).

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
  today); `dayOfMonth` and `month` for a date said by its number ("the
  23rd", "Oct 20"), which is also held to the next such day from today
  on (a later turn may keep the month of the draft it changes instead,
  as the app does); `startTime`/`endTime` as `HH:MM` (a task has only a start);
  `spanDays` (the days it runs past its first: 1 for an end after
  midnight); `isAllDay`; `assumedTime` (the times came from a meal or part of the
  day); `kind` (`event`/`task`; the first turn is an event unless it
  says `task`); `title` (whole, compared folded: case,
  accents, ß; a list names several a person would accept) or
  `titleIncludes`; `location` (folded part, or `null` for
  none) or `locationIs` (whole, folded: a turn that must not keep what
  was there); `repeat` (`freq`, `interval`, `count`, `untilMonth`, `byDay` as
  weekday codes for a weekly rule and with their place in the month for
  a monthly one, `1TU` the first Tuesday and `-1FR` the last Friday, or
  `null`);
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

A new German case names a weekday for the day rather than "morgen",
which is also "morning" (some older cases still use it).

A quick probe is a few `probe-*.json` cases dropped into `cases/`, run
with `MODEL_BENCH_CASES=probe-` and `MODEL_BENCH_OUT=<scratch>`, then
deleted.

`contacts.json` holds the fixture address books: made-up people with
`@example.com` addresses, including two Annas (a name that is a choice)
and a Max with two addresses (a choice too).

### Tags

A case's `tags` say what it exercises, and the table prints the open
cases passed per tag. `flow` is a case of several turns; `follow-up` a turn
that leans on what the draft holds (a place narrowed to its city,
company added, "invite him too"); `shift`, `day`, `correction` and
`mixed` name what a later turn does. `date` is a day by its number or an
amount of time from today, `time` a range, a length or a part of the
day, `allday` a draft without times or one that runs past midnight.
`typed` is written as people type (lower case, short forms, typos),
`dictated` as a recogniser writes speech (no punctuation, numbers as
words, a correction inside the phrase). `phone` marks a phrase from real
use, as it was heard: those are scored apart by their tag, since the
other cases were written at a desk.

### Blind cases

A case with `"blind": true` counts in every score and is named in no
table: no line of its own, no answer, no id among the cases that
flipped. The table prints the open and the blind cases apart, the blind
ones by their counts alone.

They are there because every open case gets read: its misses are what
the next training round's briefs and the next prompt change are written
from, and a bench that is read that way stops being a test of anything
but itself. A third of the cases added on 2026-11-15 are blind, picked
by their place in each area's list before any model had read one. The
rules that keep them so:

- Briefs, prompts and checks are written from the open cases' misses.
  A blind case that is read for those becomes an open one: take its flag
  off in the same change.
- `MODEL_BENCH_BLIND=show` prints them. It is for fixing a wrong
  expectation, which is found by the teacher's answers on the plain arm,
  never by the Assistant's model's.
- The report file holds every answer, a blind case's too: a rescore
  needs them. Reading one there is reading the case.
- The training export drops every phrase near a bench case, open or
  blind (`nearBench`), so the blind cases stay out of training data too.
- Nothing prints a blind case by the back door. The tag line counts the
  open cases only (a tag with one blind case would give its outcome
  away), a selection (`MODEL_BENCH_CASES`) leaves the blind cases out
  for the same reason, a rescore counts the ones it left alone instead
  of naming them, and the iPhone's measurement page, which shows every
  phrase with its answer, is given the open cases only.

What they cannot do: they were written by the person who writes the
briefs, so they share that person's idea of what people say. Phrases
from real use (`phone`) are the check on that.

### A phrase from real use

A phrase that went wrong on the phone becomes a case as it was heard,
not as it was meant: the words the recogniser wrote, the draft before it
for a later turn (as the turns that lead to it), and where a person
would have put it. It is tagged `phone` and stays open, since it was
picked for having failed. A new misreading becomes a case like this,
never an example in the prompt.

## Report

`output/bench/<yyyymmdd-hhmm>-<sha>-<provider>.json`: every turn's
input, what was heard, the model calls (prompt and raw answer), the
draft or rejection, the fields checked and failed. The table prints
cases, turns, each field's pass rate, the median time per turn and, for
the recorded turns, how many were transcribed (with the mean word error
rate), ran as their transcript for want of a file or because the
recogniser could not read it, or were skipped. Below the score it prints
the open cases passed per tag and, where the run held blind cases, the
open and the blind ones apart.

Every wording of a prompt goes through the bench before it is kept, a
reviewer's included: a model at temperature 0 answers alike run after
run, so a score change is the change (a "clearer" rewording a reviewer
asked for cost five cases). A prompt, data or model change is judged by
two runs on two commits:
`MODEL_BENCH_COMPARE=<earlier report>` prints the cases that flipped and
the fields that moved, and says when the two runs were not set up alike
(a served model's endpoint and extra request body, the report's
`settings`) or read on two days. A case the two runs read in other
words (reworded between them, or a recording heard differently) is
named and left out of the flips: it is no pair of answers to one phrase. Its last line about the flips says
whether they are more than chance: an exact sign test, how often a fair coin splits that many
flips at least as unevenly. Cases that read the same in both runs say
nothing about which is better, so the flips are a sharper measure than
the two scores: v1 to v2 was 59 to 60 of 72 cases with 8 fixed and 7
broke, which is what chance alone gives.

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

`MODEL_BENCH_PIPELINE=tuned` asks the Assistant's own model instead, on
its finder prompt (`buildTunedFinderPrompt`: "Free time as JSON.", the
days and the sentence) without a schema. The app reads that answer as
the `raw` arm does, so `raw` is the app's path there, and a length the
words do not give has to be left out (the finder then searches its
own). The report's name ends in `-tuned`.

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
floor the code's defaults give, 33 of the 124 with the rules on a
weekday and none without. On a Saturday or Sunday "this week" has no
weekday left, so the four cases that ask for a weekday this week search
no dates: the table says so, and a run meant to be compared names a
weekday (`MODEL_BENCH_TODAY`).
`MODEL_BENCH_CASES` picks cases by language ("de", "en") or id part. The
report, `output/bench/finder/finder-<yyyymmdd-hhmm>-<sha>-<provider>.json`,
keeps each prompt and answer as the model got and gave them, and each
arm's parts with what they read. `MODEL_BENCH_RESCORE=<report or folder>`
scores stored answers again by the cases and code as they are now. A
case takes `"blind": true` as the Assistant's do, and
`MODEL_BENCH_COMPARE=<earlier finder report>` prints the cases that
flipped in each arm with the same line about chance.

## Where the models stand

The bench as it grew on 2026-11-15 (305 cases and 504 turns for the
Assistant, 69 cases blind; 124 sentences for find a time, 26 blind):

| Model                     | Read as of | Cases   | Turns   | Open    | Blind |
| ------------------------- | ---------- | ------- | ------- | ------- | ----- |
| The teacher, plain arm    | 2026-11-15 | 300/305 |         |         |       |
| Assistant v1              | 2026-11-18 | 237/305 | 421/504 | 185/236 | 52/69 |
| Assistant v2              | 2026-11-18 | 263/305 | 459/504 | 200/236 | 63/69 |
| Find a time, the teacher  | 2026-11-18 | 120/124 |         | 96/98   | 24/26 |
| Find a time, Assistant v2 | 2026-11-18 | 109/124 |         | 86/98   | 23/26 |

- v1 to v2: 40 cases fixed, 14 broke, more than chance (p = 0.001). On
  the 72 cases before, the same two files were 8 fixed and 7 broke.
- The models read as of Wednesday 2026-11-18 (`MODEL_BENCH_TODAY`), the
  published files on the bundled `llama-server`. The teacher (DeepSeek
  V4 Flash) read the Assistant's cases on the day itself, a Sunday, over
  several runs as cases were reworded.
- Of the five cases the teacher misses, four are conventions it does not
  share: a to-do's title keeps its place (two cases), a destination
  stays in the title ("Trip to Vienna"), and "until Friday" stays in the
  title. The fifth no reading passes: in `flow-lunch-guests` a full name
  has to close an open choice of guests, which the thread's code does
  not do (todo.md).
- Find a time is scored without the word rules: the teacher on the app's
  prompt, v2 on its own (`MODEL_BENCH_PIPELINE=tuned`).

A later version stands beside these when it reads on the same day. Run
v2's published file again, then the new one against its report:

```bash
MODEL_BENCH=1 E2E=1 MODEL_BENCH_APPLE=0 MODEL_BENCH_TODAY=2026-11-18 \
  MODEL_BENCH_OPENAI_URL=http://127.0.0.1:8090/v1 MODEL_BENCH_OPENAI=assistant-v3 \
  MODEL_BENCH_COMPARE=<v2's report> \
  pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

## Place bench

A dictated name the recogniser mishears finds nothing, or a namesake
far away. `placeBench.e2e.ts` asks MapKit (the helper's) for each case
of `places.json` through the app's own lookup (`placeCandidates`), with
the user's two past events in the case's city: once for the place as
written, once with dictation's other readings of it (`readingsFor`:
the recogniser's own and, where the case has one, the other language's
reading, `other`), as a dictated turn asks. `PLACE_BENCH_OTHER=off`
leaves the other language out, to tell what it adds. It scores whether the
place meant was taken unasked, offered (its place in the list) and, in
the second arm, through which reading.

```bash
MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/placeBench.e2e.ts
```

`MODEL_BENCH_HELPER` and `MODEL_BENCH_OUT` work as above,
`MODEL_BENCH_CASES` picks cases by a part of their id. MapKit throttles
searches (about fifty a minute, then every one fails for a while), so
the bench keeps to forty calls a minute, waiting between lookups: a run
of every case takes about ten minutes. A case whose MapKit call failed
is counted apart: its miss may be the throttle. The report goes to
`output/bench/places/places-<yyyymmdd-hhmm>-<sha>.json`.

A case is a phrase as a recogniser read it, segment by segment with the
readings it weighed for each (the first is the segment itself), the
place a model reads in it (`location`: the words as written), the
city its user's places are in (`near`) and MapKit's names for the
place meant (`names`: a hit whose name begins with one of them, folded,
is it):

```json
{
  "id": "figlmueller-samantha",
  "said": "Dinner at Figlmüller on Friday",
  "voice": "say -v Samantha (en_US)",
  "near": "vienna",
  "location": "Figelmiller",
  "names": ["Figlmüller"],
  "heard": [
    { "alternatives": ["Dinner at"], "text": "Dinner at" },
    { "alternatives": [" Figelmiller", " Feigelmiller", " Figelmuller"], "text": " Figelmiller" },
    { "alternatives": [" on Friday."], "text": " on Friday." }
  ]
}
```

Two kinds of cases. Five macOS voices saying six Vienna places, read
by macOS 27.2's SpeechTranscriber as the app's final reading reads
(alternatives on, 2026-11-15): synthetic speech, so a measure of the
lookup, not of how often a person is misheard. And Nik's recordings
(`nik-…`, 2026-11-23, `audio/README.md`): forty places said in an
English and in a German sentence and nine short turns, each read by the
recogniser of its own language (`heard`) and by the other's (`other`),
through the helper's `transcribe`. Their `location` is the words that
stand where the place was said, picked by hand: what a model that reads
the phrase well would take. `places.test.ts` checks
in the gate that every case's place is among its words. A recording's
readings belong here as the recogniser wrote them, `voice` naming who
said it on what.

## Recordings

`audio/README.md` lists the clips the cases ask for and how to record
them. Only the Mac's helper transcribes, but SpeechAnalyzer is the
framework iOS dictates with, so the Mac stands in for both platforms.
