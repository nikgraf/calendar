import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { makeFixtureLanguageModel } from '@calendar/ai';
import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp } from './harness.ts';

// A served model: the app's main process talks Ollama's API to a server
// on this machine. The server here is a fake that answers like Ollama
// (`/api/tags`, `/api/chat` with `format`) with the deterministic fixture
// model from @calendar/ai behind it, so the whole path — Settings,
// main-process HTTP, the quick-add field — runs without Ollama or Apple
// Intelligence, and nothing depends on the date.
const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#3b82f6',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [],
};

const MODEL = 'fixture-model';
/** The key the fake's /v1 routes want. */
const SECRET = 'e2e-secret';
const INPUT = '[data-testid="quick-add-input"]';
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const blockAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')`;
const placeholder = `(document.querySelector(${JSON.stringify(INPUT)})?.placeholder ?? '')`;

interface ChatRequest {
  readonly format: unknown;
  readonly messages: Array<{ readonly content: string; readonly role: string }>;
  readonly model: string;
  readonly options: { readonly num_ctx?: number; readonly temperature?: number };
}

interface Completion {
  readonly messages: Array<{ readonly content: string }>;
  readonly response_format: {
    readonly json_schema: { readonly schema: unknown; readonly strict: boolean };
  };
}

/**
 * Ollama as the app sees it, with the fixture model answering; `tags` is
 * what it lists. The same server speaks the OpenAI shape under /v1,
 * behind a key, so the custom-endpoint path runs here too.
 */
const fakeOllama = async (): Promise<{
  readonly chats: Array<ChatRequest>;
  readonly completions: Array<Completion>;
  readonly port: number;
  readonly server: Server;
  tags: Array<string>;
}> => {
  const model = makeFixtureLanguageModel();
  const chats: Array<ChatRequest> = [];
  const completions: Array<Completion> = [];
  const fake = {
    chats,
    completions,
    port: 0,
    server: null as unknown as Server,
    tags: [`${MODEL}:latest`],
  };
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/api/tags') {
      send(200, { models: fake.tags.map((name) => ({ model: name, name })) });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/chat') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      request.on('end', () => {
        const chat = JSON.parse(raw) as ChatRequest;
        chats.push(chat);
        void model
          .generateJson({ jsonSchema: chat.format, prompt: chat.messages[0]?.content ?? '' })
          .then(
            (answer) =>
              send(200, { message: { content: JSON.stringify(answer), role: 'assistant' } }),
            (error: unknown) => send(500, { error: String(error) }),
          );
      });
      return;
    }
    if (request.url?.startsWith('/v1/')) {
      if (request.headers.authorization !== `Bearer ${SECRET}`) {
        send(401, { error: { message: 'bad key' } });
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        send(200, { data: [{ id: MODEL, object: 'model' }] });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        let raw = '';
        request.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        request.on('end', () => {
          const completion = JSON.parse(raw) as Completion;
          completions.push(completion);
          // Strict structured outputs: the answer carries null for what is not said.
          void model
            .generateJson({
              jsonSchema: completion.response_format.json_schema.schema,
              prompt: completion.messages[0]?.content ?? '',
            })
            .then(
              (answer) =>
                send(200, {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({ location: null, ...(answer as object) }),
                        role: 'assistant',
                      },
                    },
                  ],
                }),
              (error: unknown) => send(500, { error: String(error) }),
            );
        });
        return;
      }
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fake.port = typeof address === 'object' && address ? address.port : 0;
  fake.server = server;
  return fake;
};

describe('A served model', () => {
  let app: App;
  let ollama: Awaited<ReturnType<typeof fakeOllama>>;
  beforeAll(async () => {
    ollama = await fakeOllama();
    app = await launchApp(seed, {
      modelProvider: {
        baseUrl: `http://127.0.0.1:${String(ollama.port)}`,
        kind: 'ollama',
        model: MODEL,
      },
    });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
    ollama.server.close();
  });
  afterEach(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(`!!document.querySelector('[data-testid="editor"]')`))) {
        return;
      }
      await app.cdp.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('answers the quick-add field over HTTP with a guided generation', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(
      `document.querySelector('[data-testid="editor-title"]')?.textContent === 'New event'`,
    );
    // Ready: the field asks for a phrase, not for Apple Intelligence.
    await cdp.waitFor(`${placeholder}.startsWith('Lunch')`);
    await cdp.type(INPUT, 'Dinner | +2 | 19:00-20:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('19:00'));
    const chat = ollama.chats.at(-1)!;
    expect(chat.model).toBe(MODEL);
    expect(chat.options.temperature).toBe(0);
    expect(chat.options.num_ctx).toBe(16_384);
    // The schema travels as Ollama's `format`: grammar-constrained, like the helper.
    expect(chat.format).toMatchObject({ properties: { startTime: {} }, type: 'object' });
    expect(chat.messages[0]?.content).toContain('Dinner | +2 | 19:00-20:00');
  });

  it('is set up in Settings › General: the kind, a test of the server, the saved endpoint', async () => {
    const settings = await app.openSettings('general');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-section"]')`);
    expect(
      await settings.eval<string>(
        `document.querySelector('[data-testid="model-kind-ollama"]')?.getAttribute('aria-checked')`,
      ),
    ).toBe('true');
    expect(
      await settings.eval<string>(`document.querySelector('[data-testid="model-url"]').value`),
    ).toBe(`http://127.0.0.1:${String(ollama.port)}`);

    // Test: the fake lists its one model, and the select offers it.
    await settings.clickTestId('model-test');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-test-result"]')?.textContent === 'Reachable · 1 model'`,
    );
    expect(
      await settings.eval<string>(
        `[...document.querySelectorAll('[data-testid="model-name"] option')].map((o) => o.value).join(',')`,
      ),
    ).toBe(`,${MODEL}:latest`);

    // Apple Intelligence: the kind applies at once and lands in the file.
    await settings.clickTestId('model-kind-apple');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-kind-apple"]')?.getAttribute('aria-checked') === 'true'`,
    );
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(app.userDataDir, 'model-provider.json'), 'utf8')) as {
            kind: string;
          },
      )
      .toMatchObject({ kind: 'apple' });

    // Back to Ollama: the kind's defaults, then the fake's address saved over them.
    await settings.clickTestId('model-kind-ollama');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-url"]')?.value === 'http://localhost:11434'`,
    );
    await settings.eval(`document.querySelector('[data-testid="model-url"]').focus()`);
    await settings.eval(`document.execCommand('selectAll')`);
    await settings.type('[data-testid="model-url"]', `http://127.0.0.1:${String(ollama.port)}`);
    await settings.eval(`document.querySelector('[data-testid="model-name"]').focus()`);
    await settings.eval(`document.execCommand('selectAll')`);
    await settings.type('[data-testid="model-name"]', MODEL);
    await settings.clickTestId('model-save');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-saved"]')`);
    expect(
      JSON.parse(readFileSync(join(app.userDataDir, 'model-provider.json'), 'utf8')) as object,
    ).toMatchObject({
      baseUrl: `http://127.0.0.1:${String(ollama.port)}`,
      kind: 'ollama',
      model: MODEL,
    });
    // A server on this Mac: no notice about text leaving it.
    expect(
      await settings.eval<boolean>(
        `!!document.querySelector('[data-testid="model-remote-notice"]')`,
      ),
    ).toBe(false);
    await app.closeSettings();
  });

  it('speaks the OpenAI shape to a custom endpoint, strictly, with the key bound to its origin', async () => {
    const settings = await app.openSettings('general');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-section"]')`);
    await settings.clickTestId('model-kind-openai');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-key"]')`);
    const base = `http://127.0.0.1:${String(ollama.port)}/v1`;
    await settings.eval(`document.querySelector('[data-testid="model-url"]').focus()`);
    await settings.eval(`document.execCommand('selectAll')`);
    await settings.type('[data-testid="model-url"]', base);
    // Without the key the server refuses; with it, it lists its model.
    await settings.clickTestId('model-test');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-test-result"]')?.textContent === 'The server refused the API key'`,
    );
    await settings.type('[data-testid="model-key"]', SECRET);
    await settings.clickTestId('model-test');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-test-result"]')?.textContent === 'Reachable · 1 model'`,
    );
    await settings.waitFor(
      `document.querySelector('[data-testid="model-name"]')?.value === ${JSON.stringify(MODEL)}`,
    );
    await settings.clickTestId('model-save');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-saved"]')`);
    // The file holds the key only as ciphertext, bound to this origin.
    const stored = JSON.parse(
      readFileSync(join(app.userDataDir, 'model-provider.json'), 'utf8'),
    ) as { apiKey?: string; apiKeyOrigin?: string; kind: string };
    expect(stored.kind).toBe('openai');
    expect(stored.apiKeyOrigin).toBe(`http://127.0.0.1:${String(ollama.port)}`);
    expect(stored.apiKey).toBeDefined();
    expect(stored.apiKey).not.toContain(SECRET);

    // Review: the stored key must not follow a Test of another origin.
    await settings.eval(`document.querySelector('[data-testid="model-url"]').focus()`);
    await settings.eval(`document.execCommand('selectAll')`);
    await settings.type('[data-testid="model-url"]', `http://localhost:${String(ollama.port)}/v1`);
    await settings.clickTestId('model-test');
    await settings.waitFor(
      `document.querySelector('[data-testid="model-test-result"]')?.textContent === 'The server refused the API key'`,
    );
    await app.closeSettings();

    // A phrase over the OpenAI shape: strict schema out, nulls stripped on the way back.
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(`${placeholder}.startsWith('Lunch')`);
    await cdp.type(INPUT, 'Review | +1 | 10:00-11:00');
    await cdp.clickTestId('quick-add-apply');
    await cdp.waitFor(blockAt('10:00'));
    const completion = ollama.completions.at(-1)!;
    expect(completion.response_format.json_schema.strict).toBe(true);
    expect(completion.response_format.json_schema.schema).toMatchObject({
      properties: { location: { type: ['string', 'null'] }, title: { type: 'string' } },
    });
    await cdp.pressEscape();

    // Back to Ollama for the tests below.
    const again = await app.openSettings('general');
    await again.clickTestId('model-kind-ollama');
    await again.waitFor(
      `document.querySelector('[data-testid="model-url"]')?.value === 'http://localhost:11434'`,
    );
    await again.eval(`document.querySelector('[data-testid="model-url"]').focus()`);
    await again.eval(`document.execCommand('selectAll')`);
    await again.type('[data-testid="model-url"]', `http://127.0.0.1:${String(ollama.port)}`);
    await again.eval(`document.querySelector('[data-testid="model-name"]').focus()`);
    await again.eval(`document.execCommand('selectAll')`);
    await again.type('[data-testid="model-name"]', MODEL);
    await again.clickTestId('model-save');
    await again.waitFor(`!!document.querySelector('[data-testid="model-saved"]')`);
    await app.closeSettings();
  });

  it('says the model is not on the server when Ollama lists nothing', async () => {
    // Review: a fresh Ollama lists no models at all, which used to read as ready.
    ollama.tags = [];
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(`${placeholder} === 'Model not on the server'`);
    await cdp.pressEscape();
    ollama.tags = [`${MODEL}:latest`];
  });

  it('says which server is down when the endpoint cannot be reached', async () => {
    const settings = await app.openSettings('general');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-url"]')`);
    await settings.eval(`document.querySelector('[data-testid="model-url"]').focus()`);
    await settings.eval(`document.execCommand('selectAll')`);
    // A port nothing listens on.
    await settings.type('[data-testid="model-url"]', 'http://127.0.0.1:9');
    await settings.clickTestId('model-save');
    await settings.waitFor(`!!document.querySelector('[data-testid="model-saved"]')`);
    await app.closeSettings();

    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(`${placeholder} === 'Ollama unreachable'`);
    expect(
      await cdp.eval<string>(`document.querySelector('[data-testid="quick-add-input"]').disabled`),
    ).toBe(true);
  });
});
