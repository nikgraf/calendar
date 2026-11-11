import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { type LanguageModel, transcriptFromSegments } from '@calendar/ai';
import { strictSchema, withoutNulls } from '../../electron/strictSchema.ts';

/**
 * The models the bench runs on, behind the app's own `LanguageModel`
 * seam: Apple's through the desktop helper binary, a served one over
 * Ollama's API or an OpenAI-compatible endpoint (the shapes the app's
 * model provider sends), or Claude through Anthropic's API — a ceiling to
 * measure against, never a model the app ships. The helper also transcribes, for the recorded
 * turns — SpeechAnalyzer is the framework iOS dictates with, so the Mac
 * stands in for both platforms.
 */

/** One model call as the report keeps it: the prompt, what came back, how long it took. */
export interface ModelCall {
  readonly answer: unknown;
  readonly error?: string | undefined;
  readonly ms: number;
  readonly prompt: string;
}

/**
 * The model with its calls recorded per turn: `begin` opens a turn's list
 * and returns it; a call lands in the list that was open when it started,
 * however late it finishes — a people question still running when the
 * extraction failed belongs to its own turn, not the next.
 */
export const recording = (
  model: LanguageModel,
): { readonly begin: () => Array<ModelCall>; readonly model: LanguageModel } => {
  let current: Array<ModelCall> = [];
  return {
    begin: () => {
      current = [];
      return current;
    },
    model: {
      ...model,
      generateJson: async (request) => {
        const sink = current;
        const started = Date.now();
        try {
          const answer = await model.generateJson(request);
          sink.push({ answer, ms: Date.now() - started, prompt: request.prompt });
          return answer;
        } catch (error) {
          sink.push({
            answer: undefined,
            error: error instanceof Error ? error.message : String(error),
            ms: Date.now() - started,
            prompt: request.prompt,
          });
          throw error;
        }
      },
    },
  };
};

const REQUEST_TIMEOUT_MS = 180_000;

/** The helper process: newline-delimited JSON requests over stdio, as Electron main speaks to it. */
export interface HelperClient {
  readonly close: () => void;
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

export const connectHelper = (binary: string): HelperClient => {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map<
    number,
    { readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
  >();
  let id = 0;
  let buffer = '';
  let gone: Error | undefined;
  const fail = (error: Error) => {
    gone = error;
    for (const waiting of pending.values()) {
      waiting.reject(error);
    }
    pending.clear();
  };
  // A write after the helper died (EPIPE) must not throw; `gone` answers it.
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    fail(new Error(`helper failed: ${error.message}`));
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) {
        continue;
      }
      let message: { error?: string; id?: number; result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        // Not one of the helper's lines; nothing waits on it.
        continue;
      }
      // Unsolicited `{event}` lines carry no id.
      if (message.id === undefined) {
        continue;
      }
      const waiting = pending.get(message.id);
      if (waiting === undefined) {
        continue;
      }
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiting.reject(new Error(message.error));
      } else {
        waiting.resolve(message.result);
      }
    }
  });
  child.on('exit', (code) => {
    fail(new Error(`helper exited (${String(code)})`));
  });
  return {
    close: () => {
      child.kill();
    },
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (gone !== undefined) {
          reject(gone);
          return;
        }
        const mine = ++id;
        const timer = setTimeout(() => {
          pending.delete(mine);
          reject(new Error(`${method}: no answer in ${String(REQUEST_TIMEOUT_MS)} ms`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(mine, {
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
        child.stdin.write(`${JSON.stringify({ id: mine, method, params })}\n`);
      }),
  };
};

/** The helper binary: MODEL_BENCH_HELPER, else the desktop package's own build. */
export const findHelper = (): string | undefined => {
  const candidates = [
    process.env['MODEL_BENCH_HELPER'],
    fileURLToPath(new URL('../../helper/.build/release/solunivo-model-helper', import.meta.url)),
    fileURLToPath(
      new URL(
        '../../helper/.build/arm64-apple-macosx/release/solunivo-model-helper',
        import.meta.url,
      ),
    ),
  ];
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
};

/** Apple's on-device model, as the helper answers `generateJson`. */
export const helperModel = (helper: HelperClient): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const result = (await helper.request('generateJson', { prompt, schema: jsonSchema })) as {
      json: string;
    };
    return JSON.parse(result.json) as unknown;
  },
  info: async () => ({ contextTokens: 4096, name: 'Apple Intelligence' }),
  status: async () => 'ready',
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a required property holds when the words give nothing for it. */
const NONE = 'none';

/**
 * The schema with every property required but a yes-or-no one. Apple's
 * guided generation leaves out every optional property of a first phrase
 * (the title alone comes back, 70 times of 70), and fills the same
 * properties when they are required and may be empty: "" for a text, 0
 * for a number, "none" for a choice, an empty list. A yes-or-no has no
 * empty value, so it stays as it was: forced, an unsaid "all day" would
 * be an answer.
 */
export const requiredSchema = (schema: unknown, optional = false): unknown => {
  if (!isObject(schema)) {
    return schema;
  }
  if (Array.isArray(schema['enum'])) {
    return optional ? { ...schema, enum: [...schema['enum'], NONE] } : schema;
  }
  if (schema['type'] === 'array') {
    return { ...schema, items: requiredSchema(schema['items']) };
  }
  if (schema['type'] !== 'object' || !isObject(schema['properties'])) {
    return schema;
  }
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as Array<string>) : [],
  );
  const entries = Object.entries(schema['properties']);
  const properties = Object.fromEntries(
    entries.map(([key, property]) => [
      key,
      requiredSchema(property, optional || !required.has(key)),
    ]),
  );
  const forced = entries
    .filter(
      ([key, property]) =>
        required.has(key) || !isObject(property) || property['type'] !== 'boolean',
    )
    .map(([key]) => key);
  return { ...schema, properties, required: forced.sort() };
};

const isEmptyText = (value: unknown): boolean =>
  typeof value === 'string' && (value.trim() === '' || value.trim().toLowerCase() === NONE);

/**
 * The answer without its empty values: what a required property held for
 * "nothing". A list loses its empty texts too (a model asked for "none"
 * writes `["none"]` as readily as `[]`); a number in a list stays, since
 * a notification at the start is a real 0.
 */
export const withoutEmpties = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.filter((item) => !isEmptyText(item)).map(withoutEmpties);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, withoutEmpties(item)] as const)
      .filter(
        ([, item]) =>
          !isEmptyText(item) && item !== 0 && !(isObject(item) && Object.keys(item).length === 0),
      ),
  );
};

/**
 * Said before the prompt. "Nothing for a field" is nothing in the words
 * and nothing to copy: a prompt that hands over a draft to return must
 * not read this as "blank what the change does not mention".
 */
const FILL_EVERY_FIELD =
  'Every field must be in the answer. Where a field has nothing (the words give nothing for it, and there is no value to copy from a draft), write "" for a text, 0 for a number, "none" for a choice and an empty list, never a list of empty values. Where the lines below say to omit a field or leave it out, write that empty value.';

/**
 * A model asked for every field, empty where the words give nothing, and
 * read back without the empties. Put it around the recorded model, so a
 * report keeps the prompt as sent and the answer as it came.
 */
export const requiringEveryField = (model: LanguageModel): LanguageModel => ({
  ...model,
  generateJson: async ({ jsonSchema, prompt }) =>
    withoutEmpties(
      await model.generateJson({
        jsonSchema: requiredSchema(jsonSchema),
        prompt: `${FILL_EVERY_FIELD}\n${prompt}`,
      }),
    ),
});

/** What the helper says of the model: 'ready', or why not. */
export const helperStatus = async (helper: HelperClient): Promise<string> => {
  const result = (await helper.request('status', {})) as { detail?: string; status: string };
  return result.status === 'ready'
    ? 'ready'
    : `${result.status}${result.detail ? ` (${result.detail})` : ''}`;
};

/** Recorded audio in, words out — the helper's SpeechAnalyzer, assets installed on first use per locale. */
export interface Speech {
  readonly prepare: (locale: string) => Promise<void>;
  readonly transcribe: (audio: Buffer, locale: string) => Promise<string | undefined>;
}

export const helperSpeech = (helper: HelperClient): Speech => {
  const prepared = new Map<string, Promise<void>>();
  return {
    prepare: (locale) => {
      let waiting = prepared.get(locale);
      if (waiting === undefined) {
        waiting = helper.request('prepareSpeech', { locale }).then(() => undefined);
        // A failed install is tried again next time, not remembered.
        waiting.catch(() => prepared.delete(locale));
        prepared.set(locale, waiting);
      }
      return waiting;
    },
    transcribe: async (audio, locale) => {
      const result = (await helper.request('transcribe', {
        audioBase64: audio.toString('base64'),
        locale,
      })) as { segments: ReadonlyArray<{ text: string }> };
      return transcriptFromSegments(result.segments);
    },
  };
};

const GENERATE_TIMEOUT_MS = 120_000;
/** Ollama's context for the served model, as the app asks for it. */
const SERVED_CONTEXT_TOKENS = 16_384;

const headers = (apiKey: string | undefined): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
});

const contentOf = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content ?? {});

/** A model Ollama serves, asked as the app's model provider asks it. */
export const ollamaModel = (baseUrl: string, model: string): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      body: JSON.stringify({
        format: jsonSchema,
        keep_alive: '10m',
        messages: [{ content: prompt, role: 'user' }],
        model,
        options: { num_ctx: SERVED_CONTEXT_TOKENS, temperature: 0 },
        stream: false,
      }),
      headers: headers(undefined),
      method: 'POST',
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Ollama answered HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { message?: { content?: unknown } };
    return JSON.parse(contentOf(body.message?.content)) as unknown;
  },
  info: async () => ({ contextTokens: SERVED_CONTEXT_TOKENS, name: model }),
  status: async () => 'ready',
});

/**
 * A model behind an OpenAI-compatible endpoint (LM Studio, llama-server,
 * vLLM, Ollama's `/v1`), strict structured outputs. `extra` joins the
 * request body: what a server takes beyond the standard, such as the
 * switch that stops a reasoning model thinking aloud (`{"think": false}`,
 * `{"reasoning_effort": "none"}`, `{"chat_template_kwargs": …}`).
 */
export const openAiModel = (
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  extra: Readonly<Record<string, unknown>> = {},
): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: prompt, role: 'user' }],
        model,
        response_format: {
          json_schema: { name: 'answer', schema: strictSchema(jsonSchema as object), strict: true },
          type: 'json_schema',
        },
        temperature: 0,
        ...extra,
      }),
      headers: headers(apiKey),
      method: 'POST',
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`the server answered HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return withoutNulls(JSON.parse(contentOf(body.choices?.[0]?.message?.content)));
  },
  info: async () => ({ contextTokens: SERVED_CONTEXT_TOKENS, name: model }),
  status: async () => 'ready',
});

/** How hard Claude thinks before it answers (`output_config.effort`). */
export type ClaudeEffort = 'high' | 'low' | 'max' | 'medium' | 'xhigh';

const EFFORTS: ReadonlyArray<ClaudeEffort> = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `claude-haiku-5-5@low`: the model and, after an `@`, its effort (medium when left out). */
export const claudeSpec = (
  spec: string,
): { readonly effort: ClaudeEffort; readonly model: string } => {
  const [model = '', said] = spec.trim().split('@');
  return { effort: EFFORTS.find((effort) => effort === said) ?? 'medium', model };
};

/**
 * The strict schema as Claude takes it: a nullable choice written as
 * "one of these, or null". The list form the OpenAI endpoint takes
 * (`type: ['string', 'null']` beside the enum) is refused here.
 */
export const claudeSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) {
    return schema.map(claudeSchema);
  }
  if (!isObject(schema)) {
    return schema;
  }
  const { enum: choices, type } = schema;
  if (Array.isArray(choices) && Array.isArray(type)) {
    return {
      anyOf: [
        {
          ...schema,
          enum: choices.filter((choice) => choice !== null),
          type: type.find((name) => name !== 'null'),
        },
        { type: 'null' },
      ],
    };
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, claudeSchema(value)]),
  );
};

const CLAUDE_MAX_TOKENS = 16_000;

/**
 * Claude over the Messages API, the answer held to the schema by
 * structured outputs. The schema is the strict one the OpenAI endpoint
 * gets (every property required, an optional one nullable): asked with
 * optional properties, Claude leaves most of them out, a dinner's time
 * and a said place among them. The credential is the SDK's own to find
 * (`ANTHROPIC_API_KEY`, or the profile `ant auth login` stores). No
 * fallback model: a declined request is this model's failure, and the
 * report says so.
 */
export const claudeModel = (model: string, effort: ClaudeEffort): LanguageModel => {
  const client = new Anthropic();
  return {
    generateJson: async ({ jsonSchema, prompt }) => {
      const response = await client.messages.create({
        max_tokens: CLAUDE_MAX_TOKENS,
        messages: [{ content: prompt, role: 'user' }],
        model,
        output_config: {
          effort,
          format: {
            schema: claudeSchema(strictSchema(jsonSchema)) as Record<string, unknown>,
            type: 'json_schema',
          },
        },
      });
      if (response.stop_reason !== 'end_turn') {
        throw new Error(`Claude stopped with ${String(response.stop_reason)}`);
      }
      const text = response.content.find((block) => block.type === 'text');
      return withoutNulls(JSON.parse(text?.text ?? ''));
    },
    info: async () => ({ contextTokens: 1_000_000, name: model }),
    status: async () => 'ready',
  };
};
