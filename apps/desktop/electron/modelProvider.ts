import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrowserWindow, safeStorage } from 'electron';

/**
 * Which model answers the renderer's `model:generate`: Apple's on-device
 * Foundation Models through the Swift helper (the default, nothing to
 * configure), or a model served over HTTP on this Mac — Ollama's own API
 * with its preset, or any OpenAI-compatible endpoint (LM Studio,
 * llama-server, vLLM) — picked in Settings › General. The choice, the
 * endpoint and the model name are device-local: this Mac's own, never
 * part of the settings document that travels between devices. An API
 * key, when a server wants one, is kept encrypted by safeStorage, never
 * in plain text, and never leaves this file as a value.
 *
 * Only `generateJson` has a second home. Dictation and text recognition
 * stay with the helper (Apple's frameworks); a served model has no
 * microphone.
 */

export type ModelProviderKind = 'apple' | 'ollama' | 'openai';

export interface ModelProviderSettings {
  /** The server's base URL; for an OpenAI-compatible one, up to and including `/v1`. */
  readonly baseUrl: string;
  readonly kind: ModelProviderKind;
  /** The model as the server names it ("gemma3:4b"). */
  readonly model: string;
}

/** The settings as the window sees them: whether a key is set, never the key. */
export interface ModelProviderView extends ModelProviderSettings {
  readonly hasApiKey: boolean;
}

/** What a probe of an endpoint found. */
export interface EndpointProbe {
  readonly error?: string | undefined;
  /** The models the server lists; empty when it does not say. */
  readonly models: ReadonlyArray<string>;
  readonly reachable: boolean;
}

/** The status reply the renderer maps to `ModelStatus`, with who answered. */
export interface ProviderStatusReply {
  readonly detail?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly model?: string | undefined;
  readonly provider: ModelProviderKind;
  readonly status: 'ready' | 'unavailable';
}

export const PROVIDER_DEFAULTS: Readonly<Record<ModelProviderKind, ModelProviderSettings>> = {
  apple: { baseUrl: '', kind: 'apple', model: '' },
  ollama: { baseUrl: 'http://localhost:11434', kind: 'ollama', model: 'gemma3' },
  openai: { baseUrl: 'http://localhost:1234/v1', kind: 'openai', model: '' },
};

/** The context a served model is asked to keep (Ollama's `num_ctx`); capture sizes its text by it. */
export const SERVED_CONTEXT_TOKENS = 16_384;
/** Ollama keeps the model loaded this long after a call, so a thread's turns do not each reload it. */
const KEEP_ALIVE = '10m';
const PROBE_TIMEOUT_MS = 4000;
const GENERATE_TIMEOUT_MS = 120_000;
const MAX_URL_CHARS = 512;
const MAX_MODEL_CHARS = 128;
const MAX_KEY_CHARS = 512;

interface StoredSettings extends ModelProviderSettings {
  /** safeStorage ciphertext, base64. */
  readonly apiKey?: string | undefined;
}

let storePath: string | null = null;
let stored: StoredSettings = PROVIDER_DEFAULTS.apple;

const isKind = (value: unknown): value is ModelProviderKind =>
  value === 'apple' || value === 'ollama' || value === 'openai';

/** A URL the provider may call: http(s), bounded; anything else is refused. */
const validBaseUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const initModelProvider = (userData: string): void => {
  storePath = join(userData, 'model-provider.json');
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    if (isKind(parsed['kind'])) {
      const defaults = PROVIDER_DEFAULTS[parsed['kind']];
      stored = {
        apiKey: typeof parsed['apiKey'] === 'string' ? parsed['apiKey'] : undefined,
        baseUrl: validBaseUrl(parsed['baseUrl']) ? parsed['baseUrl'] : defaults.baseUrl,
        kind: parsed['kind'],
        model:
          typeof parsed['model'] === 'string' && parsed['model'].length <= MAX_MODEL_CHARS
            ? parsed['model']
            : defaults.model,
      };
    }
  } catch {
    // No file yet, or an unreadable one: Apple's model, as on a fresh install.
  }
};

const persist = () => {
  if (!storePath) {
    return;
  }
  // Temp file + rename, like the token store: a crash mid-write must not
  // leave a truncated file that reads as "Apple" with the endpoint lost.
  mkdirSync(dirname(storePath), { recursive: true });
  const temp = `${storePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, storePath);
};

export const getModelProvider = (): ModelProviderView => ({
  baseUrl: stored.baseUrl,
  hasApiKey: stored.apiKey !== undefined,
  kind: stored.kind,
  model: stored.model,
});

/**
 * Changes from the settings window, each checked: the kind from its
 * three, a bounded http(s) URL, a bounded model name, a key encrypted
 * before it is kept (null removes it). Every window hears the change.
 */
export const setModelProvider = (changes: unknown): ModelProviderView => {
  if (typeof changes !== 'object' || changes === null) {
    throw new Error('model provider: invalid changes');
  }
  const next = changes as Record<string, unknown>;
  let draft: StoredSettings = { ...stored };
  if ('kind' in next) {
    if (!isKind(next['kind'])) {
      throw new Error('model provider: invalid kind');
    }
    // A switch of kind starts from that kind's defaults; the endpoint and
    // model are then the caller's to set.
    draft = next['kind'] === draft.kind ? draft : { ...PROVIDER_DEFAULTS[next['kind']] };
  }
  if ('baseUrl' in next) {
    if (!validBaseUrl(next['baseUrl'])) {
      throw new Error('model provider: invalid base URL');
    }
    draft = { ...draft, baseUrl: next['baseUrl'].replace(/\/+$/, '') };
  }
  if ('model' in next) {
    const model = next['model'];
    if (typeof model !== 'string' || model.length > MAX_MODEL_CHARS) {
      throw new Error('model provider: invalid model');
    }
    draft = { ...draft, model: model.trim() };
  }
  if ('apiKey' in next) {
    const key = next['apiKey'];
    if (key === null || key === '') {
      const { apiKey: _gone, ...rest } = draft;
      draft = rest;
    } else if (typeof key === 'string' && key.length <= MAX_KEY_CHARS) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('model provider: the keychain is not available to keep the key');
      }
      draft = { ...draft, apiKey: safeStorage.encryptString(key).toString('base64') };
    } else {
      throw new Error('model provider: invalid API key');
    }
  }
  stored = draft;
  persist();
  const view = getModelProvider();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('model:providerChanged', view);
  }
  return view;
};

const apiKey = (): string | undefined => {
  if (stored.apiKey === undefined) {
    return undefined;
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.apiKey, 'base64'));
  } catch {
    return undefined;
  }
};

const withTimeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const headers = (key: string | undefined): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
});

/** Ollama lists "gemma3:4b"; a configured "gemma3" means its ":latest". */
const sameModel = (listed: string, wanted: string): boolean =>
  listed === wanted || listed === `${wanted}:latest`;

/**
 * Asks a server what it serves. Ollama: its tag list; OpenAI-compatible:
 * `/models`, which some servers do not implement — then the server counts
 * as reachable with nothing to list.
 */
export const probeEndpoint = async (
  settings: ModelProviderSettings,
  key: string | undefined = apiKey(),
): Promise<EndpointProbe> => {
  const base = settings.baseUrl.replace(/\/+$/, '');
  try {
    if (settings.kind === 'ollama') {
      const response = await fetch(`${base}/api/tags`, { signal: withTimeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) {
        return { error: `HTTP ${String(response.status)}`, models: [], reachable: false };
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      return {
        models: (body.models ?? []).flatMap((entry) => (entry.name ? [entry.name] : [])),
        reachable: true,
      };
    }
    const response = await fetch(`${base}/models`, {
      headers: headers(key),
      signal: withTimeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { models: [], reachable: response.status < 500 };
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return {
      models: (body.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : [])),
      reachable: true,
    };
  } catch (error) {
    return { error: String(error), models: [], reachable: false };
  }
};

/** Whether the active provider can answer now, and if not, why. */
export const providerStatus = async (
  appleStatus: () => Promise<{ detail?: string; status: string }>,
): Promise<ProviderStatusReply> => {
  if (stored.kind === 'apple') {
    const apple = await appleStatus();
    return {
      ...(apple.detail ? { detail: apple.detail } : {}),
      provider: 'apple',
      status: apple.status === 'ready' ? 'ready' : 'unavailable',
    };
  }
  const probe = await probeEndpoint(stored);
  const served = { endpoint: stored.baseUrl, model: stored.model, provider: stored.kind };
  if (!probe.reachable) {
    return { ...served, detail: 'endpointUnreachable', status: 'unavailable' };
  }
  if (stored.model === '') {
    return { ...served, detail: 'modelMissing', status: 'unavailable' };
  }
  if (probe.models.length > 0 && !probe.models.some((name) => sameModel(name, stored.model))) {
    return { ...served, detail: 'modelMissing', status: 'unavailable' };
  }
  return { ...served, status: 'ready' };
};

/** The active provider is a served model, not the helper. */
export const servedModelActive = (): boolean => stored.kind !== 'apple';

/** What the renderer reports as the model behind the seam. */
export const providerInfo = (): { contextTokens?: number; name: string } =>
  stored.kind === 'apple'
    ? { contextTokens: 4096, name: 'Apple Intelligence' }
    : { contextTokens: SERVED_CONTEXT_TOKENS, name: stored.model };

const contentOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error('the server answered without content');
};

/**
 * One guided generation over HTTP. Ollama's own API takes the JSON schema
 * as `format` (grammar-constrained, like the helper's guided generation)
 * and the context size per call; an OpenAI-compatible server takes it as
 * `response_format`. Both answer the JSON as the message text.
 */
export const providerGenerate = async (
  schema: object,
  prompt: string,
): Promise<{ readonly json: string }> => {
  const base = stored.baseUrl.replace(/\/+$/, '');
  const key = apiKey();
  if (stored.kind === 'ollama') {
    const response = await fetch(`${base}/api/chat`, {
      body: JSON.stringify({
        format: schema,
        keep_alive: KEEP_ALIVE,
        messages: [{ content: prompt, role: 'user' }],
        model: stored.model,
        options: { num_ctx: SERVED_CONTEXT_TOKENS, temperature: 0 },
        stream: false,
      }),
      headers: headers(key),
      method: 'POST',
      signal: withTimeout(GENERATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Ollama answered HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { message?: { content?: unknown } };
    return { json: contentOf(body.message?.content) };
  }
  const response = await fetch(`${base}/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: prompt, role: 'user' }],
      model: stored.model,
      response_format: {
        json_schema: { name: 'answer', schema, strict: true },
        type: 'json_schema',
      },
      temperature: 0,
    }),
    headers: headers(key),
    method: 'POST',
    signal: withTimeout(GENERATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`the server answered HTTP ${String(response.status)}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return { json: contentOf(body.choices?.[0]?.message?.content) };
};

/** A probe of settings not yet saved (the window's Test button), with the stored key if any. */
export const testModelProvider = async (candidate: unknown): Promise<EndpointProbe> => {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('model provider: invalid settings');
  }
  const next = candidate as Record<string, unknown>;
  if (!isKind(next['kind']) || next['kind'] === 'apple' || !validBaseUrl(next['baseUrl'])) {
    throw new Error('model provider: invalid settings');
  }
  const key =
    typeof next['apiKey'] === 'string' && next['apiKey'].length <= MAX_KEY_CHARS
      ? next['apiKey']
      : apiKey();
  return probeEndpoint(
    { baseUrl: next['baseUrl'].replace(/\/+$/, ''), kind: next['kind'], model: '' },
    key,
  );
};
