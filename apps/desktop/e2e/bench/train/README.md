# Training a model for the tuned arm

The bench's `tuned` arm (`../tuned.ts`) asks a model for a draft without
stating the product's conventions: the model has to have learned them.
This folder makes the training data and holds what a training run on a
Mac needs. Nothing here is part of the app, of `pnpm test` or of CI.

The idea: Claude answers the plain arm's prompt nearly without error, so
it can label practice phrases, and a small open model is trained to give
the same answers to a prompt a tenth as long.

## 1. The data

```bash
TRAIN_DATA=generate,label,said,export E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/train/dataset.e2e.ts
```

- `generate`: Claude Opus writes practice threads, 30 for each of 160
  briefs (two languages, five ways of writing, sixteen things to
  exercise: `phrases.ts`). It is shown no case of the bench.
- `label`: Claude Haiku answers every turn through the plain arm, the
  draft carried from turn to turn as the bench carries it. Phrases said
  twice and phrases that read like a bench case are left out first
  (`nearBench`).
- `said`: Haiku is asked a second, short question about each turn that
  set a day or a repeat: how the words gave the day (a date by its
  number, an amount of time from today, or another way) and which
  weekdays a repeat rules out (`asSaid.ts`).
- `export`: every labelled turn as a chat (`train.jsonl`, `valid.jsonl`),
  the prompt and the answer built by `tunedExample`, the function the arm
  itself asks with.

The files land in `output/bench/finetune/data/` (ignored by git). Each
step picks up where an earlier run stopped. It costs a few US dollars of
API use; the variables are in the head of `dataset.e2e.ts`.

The data of 2026-11-12 keeps 4,631 of 4,800 threads (146 said twice, 23
like a bench case) and makes 6,293 examples (5,988 to train on, 305 held
back), half English and half German, 1,662 of them follow-ups. 900 hold
a day as said (344 a day of the month, 431 a month and day, 125 an
amount from today) and 204 a repeat with weekdays ruled out. On 45 turns
the second answer did not fit the first ("tues 7" is seven o'clock) and
the whole date stayed; 103 whole dates still lie outside the two weeks,
most of them an end of a month or a "last Friday of the month".

### Why the day is written as said

The first round (2026-11-11) trained on the teacher's whole dates. A
tenth of its turns set a day outside the two weeks the prompt lists,
nearly all a date said by its number ("the 23rd", "12.3.", "March 14"),
and there the teacher was no guide: 80 of its dates lay in the past, and
the year it chose varied. The trained model agreed with it on 24 of 32
such held-back turns, against 210 of 225 inside the two weeks. So the
answer to learn now holds what was said ("23", "03-14", "+3w") and
`said.ts` finds the next such day. The second question decides only what
was said; it is used where it fits the first answer (the same day of the
month, the same month where one was said, the same sum for an amount)
and dropped where it does not, so a date the teacher worked out ("two
days before the 22nd") stays a whole date.

A repeat with a weekday ruled out ("every day except Sunday") is the
same kind of thing: the rule and the days ruled out are what was said,
the days left are arithmetic. The first round's briefs asked for no such
phrase, and its model listed Monday to Friday whatever was ruled out.
The second round adds two focuses, days far off and ruled-out weekdays,
as briefs of their own after the first round's, so that no brief changes
its number and no thread its "today".

## 2. Training (Apple silicon, MLX)

```bash
python3 -m venv .venv && .venv/bin/pip install mlx-lm
.venv/bin/mlx_lm.lora -c apps/desktop/e2e/bench/train/lora.yaml \
  --model <model dir> --train --data output/bench/finetune/data \
  --iters 4491 --adapter-path <adapter dir>
```

`<model dir>` is a model in Hugging Face format (`Qwen/Qwen3.5-0.8B`,
`Qwen/Qwen3.5-2B`). Things that cost time to find out:

- **Qwen3.5 trains slowly in MLX.** Three of four layers are recurrent
  (gated delta rule). MLX computes them with a Metal kernel that has no
  gradient, so training falls back to a loop over the tokens that keeps a
  megabyte of state per token, layer and example: 38 GB for four short
  examples. `grad_checkpoint` brings that down to one layer at a time, at
  about five seconds a step for batches of four. Batches of 16 run out of
  memory on a 48 GB Mac.
- **The prompt a model is asked with must read like its training
  examples.** The chat template renders an assistant turn without
  reasoning with an empty thinking block, so the model has to be asked
  with thinking off; asked with it on, it starts its answer with a stray
  token.

## 3. Scoring

```bash
.venv/bin/python apps/desktop/e2e/bench/train/serve.py --model <model dir> --adapter-path <adapter dir>
MODEL_BENCH=1 E2E=1 MODEL_BENCH_APPLE=0 MODEL_BENCH_PIPELINE=tuned \
  MODEL_BENCH_OPENAI_URL=http://127.0.0.1:8089/v1 MODEL_BENCH_OPENAI=<a name for the report> \
  pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
```

`serve.py` answers greedily and holds no schema over the answer, so an
answer that is not JSON counts against the model.

The held-back turns say how well a model learned its teacher, part by
part, and the date by where the day lies (inside the two listed weeks,
beyond them, in the past):

```bash
TRAIN_AGREE=1 E2E=1 TRAIN_AGREE_URL=http://127.0.0.1:8089/v1 TRAIN_AGREE_OUT=<answers.jsonl> \
  pnpm exec vp test run apps/desktop/e2e/bench/train/agreement.e2e.ts
```

Both answers are worked out before they are compared, so a model trained
on whole dates and one trained on days as said can be held against the
same turns (`TRAIN_AGREE_ANSWERS`, `TRAIN_AGREE_ROWS`: see the file's
head).

## 4. A file for llama.cpp (the iPhone's runtime)

`mlx_lm.fuse` saves the model as MLX names its tensors, which llama.cpp's
converter does not read. `fuse_hf.py` writes the adapter into the
original files instead, checked against MLX's own sum. The converter and
the tools come from llama.cpp's source at the version `llama.rn` vendors
(`node_modules/llama.rn/vendor/VERSIONS`); the converter needs PyTorch.
Build `llama-quantize` and `llama-server` with `-DLLAMA_USE_PREBUILT_UI=OFF`,
or the build fetches a web UI.

```bash
.venv/bin/python apps/desktop/e2e/bench/train/fuse_hf.py --model <model dir> \
  --adapter-path <adapter dir> --save-path <fused dir> [--check <mlx_lm.fuse's dir>]
.venv/bin/python llama.cpp/convert_hf_to_gguf.py <fused dir> --outfile tuned-bf16.gguf --outtype bf16
llama.cpp/build/bin/llama-quantize tuned-bf16.gguf tuned-Q4_K_M.gguf Q4_K_M
llama.cpp/build/bin/llama-server -m tuned-Q4_K_M.gguf -c 4096 -np 1 --port 8090 --offline --reasoning off
```

The bench scores the served file like any OpenAI-compatible model
(`MODEL_BENCH_OPENAI_URL=http://127.0.0.1:8090/v1`): the same file, on the
same llama.cpp, as the phone loads.

## What a result can and cannot say

The 70 cases of the bench are the test: no training phrase is one of
them or close to one. But the practice phrases were written by a model
that writes much like the people who wrote the cases, and follow-ups are
short and alike by nature ("make it 9" trains, "make it 8" tests). A
score here says the approach works on phrases of this kind, not how the
model reads what real people say.
