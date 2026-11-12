"""Writes a trained adapter into the model's own files, as Hugging Face names them.

    python fuse_hf.py --model <model dir> --adapter-path <dir> --save-path <dir> [--check <mlx fused dir>]

`mlx_lm.fuse` does the same sum, but saves the model the way MLX names
and lays out its tensors, and only the part MLX runs (no vision tower, no
multi-token head): llama.cpp's converter reads the Hugging Face names.
Here every tensor of the original file is copied as it is, and only the
weights the adapter trained are changed: `W + scale * (B·A)`, the sum
`mlx_lm`'s `LoRALinear.fuse` makes. The tokenizer, the chat template and
the config are copied beside it, so the folder converts like the original.

`--check` compares the changed weights with the ones `mlx_lm.fuse` wrote
and fails when they differ by more than rounding.
"""

import argparse
import json
import shutil
from pathlib import Path

import mlx.core as mx

# The adapter names a module as MLX does; the original file as Hugging Face does.
MLX_PREFIX = "language_model.model."
HF_PREFIX = "model.language_model."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter-path", required=True)
    parser.add_argument("--save-path", required=True)
    parser.add_argument("--check")
    args = parser.parse_args()

    # A sum over a few hundred small matrices: the GPU may be busy training.
    mx.set_default_device(mx.cpu)

    model_dir = Path(args.model)
    adapter_dir = Path(args.adapter_path)
    save_dir = Path(args.save_path)
    save_dir.mkdir(parents=True, exist_ok=True)

    scale = json.loads((adapter_dir / "adapter_config.json").read_text())["lora_parameters"]["scale"]
    adapter = mx.load(str(adapter_dir / "adapters.safetensors"))
    modules = sorted({key.rsplit(".", 1)[0] for key in adapter})

    shards = sorted(model_dir.glob("*.safetensors"))
    if len(shards) != 1:
        raise SystemExit(f"expected one weights file in {model_dir}, found {len(shards)}")
    weights, metadata = mx.load(str(shards[0]), return_metadata=True)

    changed: dict[str, mx.array] = {}
    for module in modules:
        if not module.startswith(MLX_PREFIX):
            raise SystemExit(f"an adapter module outside the language model: {module}")
        name = f"{HF_PREFIX}{module[len(MLX_PREFIX):]}.weight"
        weight = weights.get(name)
        lora_a, lora_b = adapter[f"{module}.lora_a"], adapter[f"{module}.lora_b"]
        if weight is None or weight.shape != (lora_b.shape[1], lora_a.shape[0]):
            raise SystemExit(f"no weight of the adapter's shape for {module} ({name})")
        delta = (scale * lora_b.T.astype(mx.float32)) @ lora_a.T.astype(mx.float32)
        changed[name] = (weight.astype(mx.float32) + delta).astype(weight.dtype)
    weights.update(changed)
    mx.eval(weights)

    mx.save_safetensors(str(save_dir / shards[0].name), weights, metadata=metadata or {"format": "pt"})
    for file in model_dir.iterdir():
        if file.suffix != ".safetensors" and file.is_file():
            shutil.copyfile(file, save_dir / file.name)
    print(f"{len(changed)} of {len(weights)} tensors changed (scale {scale}), saved to {save_dir}")

    if args.check:
        theirs = mx.load(str(Path(args.check) / "model.safetensors"))
        worst = 0.0
        for name, ours in changed.items():
            other = theirs[f"{MLX_PREFIX}{name[len(HF_PREFIX):]}"]
            worst = max(worst, mx.abs(ours.astype(mx.float32) - other.astype(mx.float32)).max().item())
        print(f"largest difference from the MLX fuse: {worst:.6f}")
        if worst > 1e-2:
            raise SystemExit("the fused weights are not the ones mlx_lm.fuse wrote")


if __name__ == "__main__":
    main()
