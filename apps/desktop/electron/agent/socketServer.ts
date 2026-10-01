import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentCliReply,
  type AgentHello,
  type AgentHelloReply,
  MAX_HELLO_BYTES,
  MAX_SOCKET_PATH_BYTES,
} from './protocol.ts';

/**
 * The agent gateway's listener: a Unix domain socket only this user can
 * open. Every connection must authenticate with its first line before
 * anything else is read; what follows is MCP or one CLI command.
 * node:net only — no framework parses bytes from an unauthenticated peer.
 */

export interface AgentSocketHandlers {
  /** The agent id a token belongs to, or undefined. */
  readonly authenticate: (token: string) => Promise<string | undefined>;
  readonly runCli: (token: string, argv: ReadonlyArray<string>) => Promise<AgentCliReply>;
  /** Takes over an authenticated connection for an MCP session. */
  readonly serveMcp: (session: {
    readonly input: Readable;
    readonly output: Writable;
    readonly socket: Socket;
    readonly token: string;
  }) => void;
}

export interface AgentSocketOptions {
  readonly helloTimeoutMs?: number;
  readonly log?: (message: string) => void;
  readonly maxConnections?: number;
  readonly maxConnectionsPerAgent?: number;
}

export interface AgentSocketServer {
  readonly close: () => Promise<void>;
  /** Drops every open connection of an agent (removed, or its token replaced). */
  readonly disconnect: (agentId: string) => void;
  readonly path: string;
}

const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CONNECTIONS = 32;
/** Open connections one agent may hold (MCP sessions are long-lived). */
const DEFAULT_MAX_PER_AGENT = 8;
const FINISH_LINGER_MS = 2000;

const isHello = (value: unknown): value is AgentHello => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const hello = value as Record<string, unknown>;
  return (
    typeof hello['token'] === 'string' &&
    (hello['mode'] === 'cli' || hello['mode'] === 'mcp') &&
    (hello['argv'] === undefined ||
      (Array.isArray(hello['argv']) && hello['argv'].every((arg) => typeof arg === 'string')))
  );
};

/** Whether something is accepting connections on the path right now. */
const isLive = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });

/**
 * A socket file left behind by a crash would make listen() fail forever;
 * one that answers belongs to a running instance and is never removed.
 */
const clearStaleSocket = async (path: string): Promise<void> => {
  if (!existsSync(path)) {
    return;
  }
  if (await isLive(path)) {
    throw new Error(`agent socket ${path} is in use by another running instance`);
  }
  unlinkSync(path);
};

const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

/**
 * Sends the last line and then drops the connection for good. `end()`
 * alone only closes our half: a peer that keeps its own half open (or
 * leaves unread bytes behind) would hold one of the connection slots
 * forever — without ever having shown a token.
 */
const finish = (socket: Socket, value: unknown): void => {
  socket.end(`${JSON.stringify(value)}\n`, () => socket.destroy());
  // A peer that never reads must not keep the socket alive either.
  setTimeout(() => socket.destroy(), FINISH_LINGER_MS).unref();
};

export const startAgentSocketServer = async (
  path: string,
  handlers: AgentSocketHandlers,
  options: AgentSocketOptions = {},
): Promise<AgentSocketServer> => {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `agent socket path is ${Buffer.byteLength(path)} bytes; macOS allows ${MAX_SOCKET_PATH_BYTES}: ${path}`,
    );
  }
  const log = options.log ?? (() => {});
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxPerAgent = options.maxConnectionsPerAgent ?? DEFAULT_MAX_PER_AGENT;

  // A directory this run creates is private; an existing one keeps its mode
  // (the socket's own 0600 is what gates access either way).
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  await clearStaleSocket(path);

  const sockets = new Map<Socket, string | undefined>();

  const reject = (socket: Socket, code: string, message: string): void => {
    const reply: AgentHelloReply = { error: { code, message }, ok: false };
    finish(socket, reply);
  };

  const onHello = async (socket: Socket, line: string, rest: Buffer): Promise<void> => {
    let hello: unknown;
    try {
      hello = JSON.parse(line);
    } catch {
      reject(socket, 'BadRequest', 'The first line must be a JSON hello.');
      return;
    }
    if (!isHello(hello)) {
      reject(socket, 'BadRequest', 'Malformed hello.');
      return;
    }
    if (hello.v !== AGENT_PROTOCOL_VERSION) {
      reject(
        socket,
        'VersionMismatch',
        `This Solunivo speaks agent protocol ${AGENT_PROTOCOL_VERSION}; update the app or the CLI so both match.`,
      );
      return;
    }
    const agentId = await handlers.authenticate(hello.token);
    if (agentId === undefined) {
      reject(
        socket,
        'Unauthorized',
        'Unknown agent token. Create an agent in Solunivo → Settings → Agents and use its token.',
      );
      return;
    }
    if (socket.destroyed) {
      return;
    }
    const held = [...sockets.values()].filter((owner) => owner === agentId).length;
    if (held >= maxPerAgent) {
      reject(
        socket,
        'TooManyConnections',
        `This agent already has ${maxPerAgent} connections open; close one first.`,
      );
      return;
    }
    sockets.set(socket, agentId);
    const accepted: AgentHelloReply = { ok: true };
    if (hello.mode === 'cli') {
      writeLine(socket, accepted);
      finish(socket, await handlers.runCli(hello.token, hello.argv ?? []));
      return;
    }
    writeLine(socket, accepted);
    // A buffering stream in front of the session: whatever arrived after
    // the hello already belongs to MCP, and nothing may be dropped before
    // the session attaches its reader.
    const input = new PassThrough();
    if (rest.length > 0) {
      input.write(rest);
    }
    socket.pipe(input);
    handlers.serveMcp({ input, output: socket, socket, token: hello.token });
  };

  const onConnection = (socket: Socket): void => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.set(socket, undefined);
    socket.on('close', () => sockets.delete(socket));
    // A peer that vanishes mid-write must not surface as an uncaught error.
    socket.on('error', () => socket.destroy());

    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), helloTimeoutMs);
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.length > MAX_HELLO_BYTES) {
          socket.destroy();
        }
        return;
      }
      if (newline > MAX_HELLO_BYTES) {
        socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      // Paused until a handler takes the stream over, so nothing is dropped.
      socket.pause();
      const line = pending.subarray(0, newline).toString('utf8');
      const rest = pending.subarray(newline + 1);
      void onHello(socket, line, rest).catch((error: unknown) => {
        log(`connection failed: ${String(error)}`);
        socket.destroy();
      });
    };
    socket.on('data', onData);
    socket.on('close', () => clearTimeout(timer));
  };

  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject_) => {
    server.once('error', reject_);
    // The socket is created 0600 from the start: no window in which another
    // user could connect before a chmod.
    const previousUmask = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off('error', reject_);
        resolve();
      });
    } finally {
      process.umask(previousUmask);
    }
  });
  chmodSync(path, 0o600);
  server.on('error', (error) => log(`server error: ${String(error)}`));
  log(`listening on ${path}`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.keys()) {
          socket.destroy();
        }
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            // Already gone (node removes the socket file on close).
          }
          resolve();
        });
      }),
    disconnect: (agentId) => {
      for (const [socket, owner] of sockets) {
        if (owner === agentId) {
          socket.destroy();
        }
      }
    },
    path,
  };
};
