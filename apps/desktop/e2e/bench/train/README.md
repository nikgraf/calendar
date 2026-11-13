# Training a model for the tuned arm

The bench's `tuned` arm (`../tuned.ts`) asks a model for a draft without
stating the product's conventions: the model has to have learned them.
This folder makes the training data and holds what a training run on a
Mac needs. Nothing here is part of the app, of `pnpm test` or of CI.

The idea: a large open model answers the plain arm's prompt nearly
without error, so it can label practice phrases, and a small open model
is trained to give the same answers to a prompt a tenth as long.

**Whose outputs may be trained on.** Only a model whose licence and
whose API's terms both allow training other models on its output.
Claude's may not: Anthropic's Usage Policy forbids using its outputs "to
train an AI model (e.g., 'model scraping' or 'model distillation')"
without Anthropic's prior authorization, and `dataset.e2e.ts` refuses a
Claude model. The data is made with DeepSeek V4 over DeepSeek's own API:
MIT weights, and its Open Platform terms (effective 2026-04-29, section
4.2(3)) name "training other models (such as model distillation)" as a
permitted use. The first rounds of 2026-11-11 and 2026-11-12 were made
with Claude and are set aside in `output/bench/finetune/claude-made/`;
nothing in there is trained on or shipped.

## 1. The data

```bash
TRAIN_OPENAI_KEY=… TRAIN_DATA=names,generate,label,said,export E2E=1 \
  pnpm exec vp test run apps/desktop/e2e/bench/train/dataset.e2e.ts
```

- `names`: DeepSeek V4-Pro writes the people and places the phrases may
  name (60 and 40); anyone the bench's books hold is left out.
- `generate`: V4-Pro writes practice threads, 30 for each of 160 briefs
  (two languages, five ways of writing, sixteen things to exercise:
  `phrases.ts`). It is shown no case of the bench.
- `label`: V4-Flash answers every turn through the plain arm, the draft
  carried from turn to turn as the bench carries it. Phrases said twice,
  phrases that read like a bench case and phrases that repeat an example
  the briefs quote are left out first (`nearBench`,
  `repeatsBriefExample`).
- `said`: V4-Flash is asked a second, short question about each turn
  that set a day or a repeat: how the words gave the day (a date by its
  number, an amount of time from today, or another way) and which
  weekdays a repeat rules out (`asSaid.ts`).
- `export`: every labelled turn as a chat (`train.jsonl`, `valid.jsonl`),
  the prompt and the answer built by `tunedExample`, the function the arm
  itself asks with.

Both run with brief thinking (`{"thinking":{"type":"enabled"},
"reasoning_effort":"low"}` in `TRAIN_*_EXTRA`). On the bench's plain arm
(2026-11-12, `MODEL_BENCH_OPENAI_JSON=object`): Flash thinking 65 of 70,
Pro 64 with or without, Flash without thinking 61; Claude Haiku, the
teacher of the set-aside rounds, scored 65. DeepSeek's API takes no JSON
schema, so the schema goes into the prompt and the answer comes in JSON
mode (`TRAIN_OPENAI_JSON=object`). The files land in
`output/bench/finetune/data/` (ignored by git), every answer's token
counts in `usage.jsonl`. Each step picks up where an earlier run stopped.
A run costs a few US dollars. A published model's files are kept with it
in [nikgraf/calendar-models](https://github.com/nikgraf/calendar-models):
v1's data in `data/v1/`, its bench report and held-back answers in
`reports/v1/`, and the adapter it was made from on its release, which
`fuse_hf.py` (section 4) turns into v1's weights again.

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
  --iters 4496 --adapter-path <adapter dir>
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
