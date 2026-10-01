import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_HELLO_BYTES } from './protocol.ts';
import {
  type AgentSocketHandlers,
  type AgentSocketServer,
  startAgentSocketServer,
} from './socketServer.ts';

const TOKEN = 'sol_good';

let dir: string | undefined;
let server: AgentSocketServer | undefined;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await server?.close();
  server = undefined;
  if (dir) {
    rmSync(dir, { force: true, recursive: true });
    dir = undefined;
  }
});

const socketPath = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'sol-agent-'));
  return join(dir, 'run', 'agent.sock');
};

const handlers = (overrides: Partial<AgentSocketHandlers> = {}): AgentSocketHandlers => ({
  authenticate: async (token) => (token === TOKEN ? 'agent-1' : undefined),
  runCli: async (_token, argv) => ({ exitCode: 0, stderr: '', stdout: argv.join(' ') }),
  serveMcp: ({ input, output }) => {
    // Echo every line back, upper-cased: enough to see the stream is intact.
    input.on('data', (chunk: Buffer) => output.write(chunk.toString('utf8').toUpperCase()));
  },
  ...overrides,
});

/** A raw client collecting everything the server sends until it closes. */
const dial = (path: string) => {
  const socket: Socket = connect(path);
  cleanups.push(() => socket.destroy());
  let received = '';
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });
  socket.on('error', () => {});
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    closed,
    lines: () => received.split('\n').filter((line) => line !== ''),
    socket,
    until: async (count: number) => {
      for (let spins = 0; spins < 400 && received.split('\n').length - 1 < count; spins += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return received.split('\n').filter((line) => line !== '');
    },
  };
};

const hello = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ mode: 'cli', token: TOKEN, v: 1, ...overrides })}\n`;

describe('agent socket server', () => {
  it('is private to the user: 0700 directory, 0600 socket', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir!, 'run')).mode & 0o777).toBe(0o700);
  });

  it('runs one CLI command for an authenticated hello, then closes', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers());
    const client = dial(path);
    client.socket.write(hello({ argv: ['list_events', '--from', 'x'] }));
    await client.closed;
    expect(client.lines().map((line) => JSON.parse(line) as unknown)).toEqual([
      { ok: true },
      { exitCode: 0, stderr: '', stdout: 'list_events --from x' },
    ]);
  });

  it('accepts a hello that arrives in pieces', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers());
    const client = dial(path);
    const text = hello({ argv: ['tools'] });
    client.socket.write(text.slice(0, 7));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.socket.write(text.slice(7));
    await client.closed;
    expect(JSON.parse(client.lines()[1]!)).toMatchObject({ stdout: 'tools' });
  });

  it('refuses an unknown token, a malformed hello and another protocol version', async () => {
    const path = socketPath();
    const seen: Array<string> = [];
    server = await startAgentSocketServer(
      path,
      handlers({
        runCli: async () => {
          seen.push('cli');
          return { exitCode: 0, stderr: '', stdout: '' };
        },
        serveMcp: () => seen.push('mcp'),
      }),
    );
    const codeFor = async (payload: string) => {
      const client = dial(path);
      client.socket.write(payload);
      await client.closed;
      return (JSON.parse(client.lines()[0]!) as { error: { code: string } }).error.code;
    };
    expect(await codeFor(hello({ token: 'sol_wrong' }))).toBe('Unauthorized');
    expect(await codeFor(hello({ mode: 'mcp', token: 'sol_wrong' }))).toBe('Unauthorized');
    expect(await codeFor('not json\n')).toBe('BadRequest');
    expect(await codeFor(`${JSON.stringify({ mode: 'shell', token: TOKEN, v: 1 })}\n`)).toBe(
      'BadRequest',
    );
    expect(await codeFor(hello({ v: 2 }))).toBe('VersionMismatch');
    // Nothing reached a handler.
    expect(seen).toEqual([]);
  });

  it('drops a peer that sends no newline, too much, or nothing at all', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers(), { helloTimeoutMs: 60 });
    const flood = dial(path);
    flood.socket.write('x'.repeat(MAX_HELLO_BYTES + 10));
    await flood.closed;
    expect(flood.lines()).toEqual([]);

    const silent = dial(path);
    await silent.closed;
    expect(silent.lines()).toEqual([]);
  });

  it('releases the slot of a refused peer that never hangs up', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers(), { maxConnections: 1 });
    // Keeps its own half open after the refusal, like a peer squatting on a slot.
    const squatter = connect({ allowHalfOpen: true, path });
    cleanups.push(() => squatter.destroy());
    squatter.on('error', () => {});
    squatter.write('nope\n');
    // And one that leaves unread bytes behind before it goes away.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const litterer = dial(path);
    litterer.socket.write('nope\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    litterer.socket.write('and some more that nobody reads\n');
    litterer.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // With a single slot, a real client only gets through if both were dropped.
    const client = dial(path);
    client.socket.write(hello({ argv: ['tools'] }));
    await client.closed;
    expect(JSON.parse(client.lines()[1] ?? '{}')).toMatchObject({ stdout: 'tools' });
  });

  it('drops a hello whose first line is longer than a hello can be', async () => {
    const path = socketPath();
    const seen: Array<string> = [];
    server = await startAgentSocketServer(
      path,
      handlers({
        authenticate: async (token) => {
          seen.push(token);
          return 'agent-1';
        },
      }),
    );
    const client = dial(path);
    client.socket.write(`${hello({ argv: ['x'.repeat(MAX_HELLO_BYTES)] })}`);
    await client.closed;
    expect(client.lines()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('limits how many connections one agent holds open', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers(), { maxConnectionsPerAgent: 1 });
    const first = dial(path);
    first.socket.write(hello({ mode: 'mcp' }));
    await first.until(1);
    const second = dial(path);
    second.socket.write(hello({ mode: 'mcp' }));
    await second.closed;
    expect(JSON.parse(second.lines()[0]!)).toMatchObject({
      error: { code: 'TooManyConnections' },
      ok: false,
    });
    // The first session is untouched.
    first.socket.write('still here\n');
    expect(await first.until(2)).toEqual(['{"ok":true}', 'STILL HERE']);
  });

  it('hands an MCP session every byte after the hello, even from the same packet', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers());
    const client = dial(path);
    client.socket.write(`${hello({ mode: 'mcp' })}first\n`);
    client.socket.write('second\n');
    expect(await client.until(3)).toEqual(['{"ok":true}', 'FIRST', 'SECOND']);
  });

  it('disconnects the open connections of one agent only', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(
      path,
      handlers({ authenticate: async (token) => token.replace('sol_', 'agent-') }),
    );
    const one = dial(path);
    const two = dial(path);
    one.socket.write(hello({ mode: 'mcp', token: 'sol_1' }));
    two.socket.write(hello({ mode: 'mcp', token: 'sol_2' }));
    await one.until(1);
    await two.until(1);
    server.disconnect('agent-1');
    await one.closed;
    two.socket.write('still here\n');
    expect(await two.until(2)).toEqual(['{"ok":true}', 'STILL HERE']);
  });

  it('caps concurrent connections', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers(), { maxConnections: 1 });
    const first = dial(path);
    first.socket.write(hello({ mode: 'mcp' }));
    await first.until(1);
    const second = dial(path);
    await second.closed;
    expect(second.lines()).toEqual([]);
  });

  it('replaces a stale socket file but never one that is in use', async () => {
    const path = socketPath();
    server = await startAgentSocketServer(path, handlers());
    await server.close();
    expect(existsSync(path)).toBe(false);
    // A leftover from a crash: a file nobody listens on.
    writeFileSync(path, '');
    server = await startAgentSocketServer(path, handlers());
    expect(statSync(path).isSocket()).toBe(true);
    await server.close();
    server = undefined;

    const other = createServer();
    await new Promise<void>((resolve) => other.listen(path, resolve));
    cleanups.push(() => other.close());
    await expect(startAgentSocketServer(path, handlers())).rejects.toThrow(/in use/u);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a path longer than a Unix socket address can hold', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sol-agent-'));
    const path = join(dir, 'x'.repeat(120), 'agent.sock');
    await expect(startAgentSocketServer(path, handlers())).rejects.toThrow(/macOS allows 103/u);
    expect(existsSync(join(dir, 'x'.repeat(120)))).toBe(false);
  });
});
