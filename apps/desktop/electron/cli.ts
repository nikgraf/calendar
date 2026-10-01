import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import packageJson from '../package.json' with { type: 'json' };
import {
  AGENT_BUNDLE_ENV,
  AGENT_PROTOCOL_VERSION,
  AGENT_SOCKET_ENV,
  AGENT_TOKEN_ENV,
  type AgentCliReply,
  type AgentHello,
  type AgentHelloReply,
  agentSocketPath,
  MAX_LINE_BYTES,
} from './agent/protocol.ts';

/**
 * `solunivo-cli`: the relay an agent starts. It holds no logic — it
 * authenticates to the running app over its Unix socket and then either
 * pipes stdio (MCP) or prints the reply to one command. Everything else,
 * the tools and their permission checks included, lives in the app.
 *
 * Bundled on its own (node built-ins only) and run with the app's own
 * Electron binary as Node, so it needs no Node install.
 */

const USAGE = `Usage:
  solunivo-cli mcp                      Serve MCP over stdio (for an agent's MCP config)
  solunivo-cli tools                    List the tools and their input schemas (JSON)
  solunivo-cli <tool> [--flag value …]  Call one tool; the result is printed as JSON
  solunivo-cli --version

The agent token is read from the ${AGENT_TOKEN_ENV} environment variable; create an
agent in Solunivo → Settings → Agents to get one. Solunivo must be running.
`;

const LAUNCH_WAIT_MS = 15_000;
const RETRY_EVERY_MS = 250;

const fail = (message: string, exitCode = 1): never => {
  process.stderr.write(`solunivo-cli: ${message}\n`);
  process.exit(exitCode);
};

const tryConnect = (path: string): Promise<Socket | undefined> =>
  new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', () => resolve(undefined));
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the app this relay ships in, without a window and without taking
 * focus. Through LaunchServices (`open`), never by exec'ing the binary:
 * the app must not inherit this process's environment — least of all
 * ELECTRON_RUN_AS_NODE.
 */
const launchApp = (bundle: string): void => {
  const { [AGENT_TOKEN_ENV]: _token, ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  spawn('/usr/bin/open', ['-g', '-a', bundle, '--args', '--background'], {
    detached: true,
    env,
    stdio: 'ignore',
  }).unref();
};

const connectToApp = async (): Promise<Socket> => {
  const bundle = process.env[AGENT_BUNDLE_ENV];
  const path = agentSocketPath({
    env: process.env,
    home: homedir(),
    packaged: bundle !== undefined,
  });
  const first = await tryConnect(path);
  if (first) {
    return first;
  }
  // An explicit socket path is a test or a custom setup: never launch anything for it.
  if (bundle !== undefined && process.env[AGENT_SOCKET_ENV] === undefined) {
    launchApp(bundle);
    const deadline = Date.now() + LAUNCH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(RETRY_EVERY_MS);
      const socket = await tryConnect(path);
      if (socket) {
        return socket;
      }
    }
  }
  return fail(
    `could not reach Solunivo at ${path}. The app must be running and have at least one agent (Settings → Agents).`,
  );
};

/** Reads newline-delimited lines off the socket until the caller takes the stream over. */
const lineReader = (socket: Socket) => {
  let pending = Buffer.alloc(0);
  let waiting: ((line: string | undefined) => void) | undefined;
  let ended = false;
  const flush = (): void => {
    if (!waiting) {
      return;
    }
    const newline = pending.indexOf(0x0a);
    if (newline !== -1) {
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else if (ended || pending.length > MAX_LINE_BYTES) {
      const resolve = waiting;
      waiting = undefined;
      resolve(undefined);
    }
  };
  const onData = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    flush();
  };
  const onEnd = (): void => {
    ended = true;
    flush();
  };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('close', onEnd);
  return {
    next: (): Promise<string | undefined> =>
      new Promise((resolve) => {
        waiting = resolve;
        flush();
      }),
    /** Stops reading lines; returns the bytes already received past the last line. */
    release: (): Buffer => {
      socket.off('data', onData);
      return pending;
    },
  };
};

const parse = <T>(line: string | undefined): T => {
  if (line === undefined) {
    return fail('Solunivo closed the connection.');
  }
  try {
    return JSON.parse(line) as T;
  } catch {
    return fail('unexpected reply from Solunivo.');
  }
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    // The tool list is the app's to print (`solunivo-cli tools`); this must work without it.
    process.stdout.write(USAGE);
    return;
  }
  const token = process.env[AGENT_TOKEN_ENV];
  if (!token) {
    fail(
      `${AGENT_TOKEN_ENV} is not set. Create an agent in Solunivo → Settings → Agents and pass its token in that environment variable.`,
      2,
    );
    return;
  }
  const mode = argv[0] === 'mcp' ? 'mcp' : 'cli';
  const socket = await connectToApp();
  socket.on('error', (error) => fail(`connection lost: ${error.message}`));
  const lines = lineReader(socket);

  const hello: AgentHello = {
    ...(mode === 'cli' ? { argv } : {}),
    mode,
    token,
    v: AGENT_PROTOCOL_VERSION,
  };
  socket.write(`${JSON.stringify(hello)}\n`);
  const reply = parse<AgentHelloReply>(await lines.next());
  if (!reply.ok) {
    fail(reply.error.message, reply.error.code === 'Unauthorized' ? 3 : 1);
    return;
  }

  if (mode === 'cli') {
    const result = parse<AgentCliReply>(await lines.next());
    socket.end();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }

  // MCP: from here on this process is a pipe.
  const early = lines.release();
  if (early.length > 0) {
    process.stdout.write(early);
  }
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.on('close', () => process.exit(0));
};

await main();
