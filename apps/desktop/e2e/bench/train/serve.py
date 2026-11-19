"""Serves a trained model to the bench: one OpenAI-style chat endpoint over MLX.

    python serve.py --model <model dir> [--adapter-path <dir>] [--port 8089]

The bench asks it like any OpenAI-compatible server
(MODEL_BENCH_OPENAI_URL=http://127.0.0.1:8089/v1, MODEL_BENCH_OPENAI=<any name>).
The prompt is rendered with the model's own chat template and thinking
switched off, which is how a training example reads up to its answer (an
assistant turn without reasoning is rendered with an empty thinking block;
left on, the prompt would end inside an open one, which no example does,
and the model starts its answer with a stray token). The answer is what
the model writes after it: greedy, no schema held over it, nothing parsed
out of it. `mlx_lm.server` is not used because it files such an answer
under "reasoning" and leaves the content empty.
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from mlx_lm import load, stream_generate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter-path")
    parser.add_argument("--port", type=int, default=8089)
    parser.add_argument("--max-tokens", type=int, default=300)
    args = parser.parse_args()

    model, tokenizer = load(args.model, adapter_path=args.adapter_path)

    def answer(messages: list[dict]) -> dict:
        prompt = tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, enable_thinking=False
        )
        started = time.perf_counter()
        text = ""
        last = None
        for last in stream_generate(model, tokenizer, prompt, max_tokens=args.max_tokens):
            text += last.text
        return {
            "choices": [
                {
                    "finish_reason": getattr(last, "finish_reason", None),
                    "index": 0,
                    "message": {"content": text.strip(), "role": "assistant"},
                }
            ],
            "usage": {
                "completion_tokens": getattr(last, "generation_tokens", 0),
                "prompt_tokens": len(prompt),
                "seconds": round(time.perf_counter() - started, 3),
            },
        }

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 (the base class names it)
            self._send(200, {"data": [{"id": args.model, "object": "model"}]})

        def do_POST(self) -> None:  # noqa: N802
            if not self.path.rstrip("/").endswith("/chat/completions"):
                self._send(404, {"error": "only /v1/chat/completions is served"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                self._send(200, answer(body["messages"]))
            except Exception as error:  # the bench reads a failed call as the model's
                self._send(500, {"error": str(error)})

        def log_message(self, *_: object) -> None:
            pass

    print(f"serving {args.model} on http://127.0.0.1:{args.port}/v1", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
