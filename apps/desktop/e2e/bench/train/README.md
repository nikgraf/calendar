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
TRAIN_DATA=generate,label,export E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/train/dataset.e2e.ts
```

- `generate`: Claude Opus writes practice threads, 30 for each of 140
  briefs (two languages, five ways of writing, fourteen things to
  exercise: `phrases.ts`). It is shown no case of the bench.
- `label`: Claude Haiku answers every turn through the plain arm, the
  draft carried from turn to turn as the bench carries it. Phrases said
  twice and phrases that read like a bench case are left out first
  (`nearBench`).
- `export`: every labelled turn as a chat (`train.jsonl`, `valid.jsonl`),
  the prompt and the answer built by `tunedExample`, the function the arm
  itself asks with.

The files land in `output/bench/finetune/data/` (ignored by git). Each
step picks up where an earlier run stopped. The run of 2026-11-11 kept
4,045 of 4,200 threads (135 said twice, 20 like a bench case) and made
5,504 examples, half English and half German, 1,459 of them follow-ups.
It costs a few US dollars of API use; the variables are in the head of
`dataset.e2e.ts`.

## 2. Training (Apple silicon, MLX)

```bash
python3 -m venv .venv && .venv/bin/pip install mlx-lm
.venv/bin/mlx_lm.lora -c apps/desktop/e2e/bench/train/lora.yaml \
  --model <model dir> --train --data output/bench/finetune/data \
  --iters 3927 --adapter-path <adapter dir>
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

## What a result can and cannot say

The 70 cases of the bench are the test: no training phrase is one of
them or close to one. But the practice phrases were written by a model
that writes much like the people who wrote the cases, and follow-ups are
short and alike by nature ("make it 9" trains, "make it 8" tests). A
score here says the approach works on phrases of this kind, not how the
model reads what real people say.
