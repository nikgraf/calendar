import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { request } from 'node:http';

/**
 * llama.cpp's server (bundled, `scripts/build-llama-server.sh`) running the
 * Assistant's model: started on the first question, on a UNIX socket (no
 * TCP port) with a key made for each start, so only this app reaches it.
 * It asks the way the iPhone asks (`apps/ios/src/openModel.ts`) and the
 * bench scored the file: a 4,096-token context, every layer on the GPU,
 * thinking off, temperature 0, no schema. One question at a time, each
 * cut off after 30 s; a server that died starts again with the next
 * question, and one left idle lets the model's memory go
 * (`--sleep-idle-seconds`).
 */

/** An answer that takes longer than this is given up (the iPhone's limit too). */
export const ANSWER_LIMIT_MS = 30_000;
/** Loading the model and opening the socket. */
const START_LIMIT_MS = 60_000;
const IDLE_SECONDS = 600;
const MAX_ANSWER_TOKENS = 512;

export interface LlamaServer {
  /** The model's answer text for one prompt (the JSON starts at its first brace). */
  readonly ask: (prompt: string) => Promise<string>;
  readonly stop: () => void;
}

interface Reply {
  readonly body: string;
  readonly status: number;
}

const call = (
  socketPath: string,
  key: string,
  path: string,
  body: string | undefined,
  timeoutMs: number,
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        method: body === undefined ? 'GET' : 'POST',
        path,
        socketPath,
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ body: text, status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    // Closing the connection makes the server drop the question.
    req.on('timeout', () => req.destroy(new Error('The Assistant’s model took too long.')));
    req.on('error', reject);
    req.end(body);
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `content` of a chat completion, or why there is none. */
export const contentOf = (reply: Reply): string => {
  if (reply.status !== 200) {
    throw new Error(`The Assistant’s model answered ${String(reply.status)}.`);
  }
  const parsed = JSON.parse(reply.body) as {
    readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('The Assistant’s model gave no answer.');
  }
  return content;
};

export const createLlamaServer = ({
  binary,
  socketPath,
}: {
  readonly binary: string;
  readonly socketPath: string;
}): LlamaServer & { readonly use: (modelPath: string) => void } => {
  let modelPath: string | undefined;
  let child: ChildProcess | undefined;
  let key = '';
  let starting: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const stop = () => {
    child?.kill();
    child = undefined;
    starting = undefined;
    rmSync(socketPath, { force: true });
  };

  const start = (path: string): Promise<void> => {
    stop();
    key = randomBytes(24).toString('hex');
    const server = spawn(
      binary,
      [
        '-m',
        path,
        '-c',
        '4096',
        '-np',
        '1',
        '-ngl',
        '99',
        '--host',
        socketPath,
        '--api-key',
        key,
        '--offline',
        '--reasoning',
        'off',
        '--sleep-idle-seconds',
        String(IDLE_SECONDS),
        '--log-disable',
      ],
      { stdio: 'ignore' },
    );
    child = server;
    server.on('exit', () => {
      if (child === server) {
        child = undefined;
        starting = undefined;
      }
    });
    const ready = (async () => {
      const deadline = Date.now() + START_LIMIT_MS;
      while (Date.now() < deadline) {
        if (child !== server) {
          throw new Error('The Assistant’s model could not start.');
        }
        try {
          if ((await call(socketPath, key, '/health', undefined, 1000)).status === 200) {
            return;
          }
        } catch {
          // Not listening yet.
        }
        await sleep(200);
      }
      stop();
      throw new Error('The Assistant’s model did not start in time.');
    })();
    starting = ready;
    return ready;
  };

  const ask = async (prompt: string): Promise<string> => {
    const path = modelPath;
    if (path === undefined) {
      throw new Error('The Assistant’s model is not on this Mac yet.');
    }
    if (child === undefined || starting === undefined) {
      await start(path);
    } else {
      await starting;
    }
    const body = JSON.stringify({
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: MAX_ANSWER_TOKENS,
      messages: [{ content: prompt, role: 'user' }],
      temperature: 0,
    });
    return contentOf(await call(socketPath, key, '/v1/chat/completions', body, ANSWER_LIMIT_MS));
  };

  return {
    // One question at a time: the server has one slot, and a turn waits for the one before.
    ask: (prompt) => {
      const next = queue.then(
        () => ask(prompt),
        () => ask(prompt),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    stop,
    use: (path) => {
      if (path !== modelPath) {
        modelPath = path;
        stop();
      }
    },
  };
};
