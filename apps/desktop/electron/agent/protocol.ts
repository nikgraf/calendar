import { join } from 'node:path';

/**
 * What the CLI relay and the main process agree on. Plain Node only: the
 * relay imports this file and must stay free of effect, the MCP SDK and
 * everything else the main bundle carries.
 *
 * A connection opens with one hello line (JSON + "\n") and gets one reply
 * line. After `{ ok: true }` an `mcp` connection carries MCP's own
 * newline-delimited JSON-RPC in both directions; a `cli` connection gets
 * one more line — the command's exit code and output — and is closed.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** The agent's bearer token. Read from the environment only — never argv, never logged. */
export const AGENT_TOKEN_ENV = 'SOLUNIVO_AGENT_TOKEN';
/** Overrides the socket path (the e2e harness points it under its temp profile). */
export const AGENT_SOCKET_ENV = 'CALENDAR_AGENT_SOCKET';
/** Set by the bundled wrapper: the .app the relay ships in (and may launch). */
export const AGENT_BUNDLE_ENV = 'SOLUNIVO_CLI_BUNDLE';

/** sockaddr_un.sun_path is 104 bytes on macOS, NUL included. */
export const MAX_SOCKET_PATH_BYTES = 103;
/** The hello is a token and an argv — not a payload. */
export const MAX_HELLO_BYTES = 64 * 1024;
/** One MCP message or CLI reply; larger input closes the connection. */
export const MAX_LINE_BYTES = 1024 * 1024;

export interface AgentHello {
  /** `cli` only: the command line after the program name. */
  readonly argv?: ReadonlyArray<string>;
  readonly mode: 'cli' | 'mcp';
  readonly token: string;
  readonly v: typeof AGENT_PROTOCOL_VERSION;
}

export interface AgentWireError {
  readonly code: string;
  readonly message: string;
}

export type AgentHelloReply =
  | { readonly error: AgentWireError; readonly ok: false }
  | { readonly ok: true };

export interface AgentCliReply {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Where the gateway listens. The packaged app and a dev build use
 * different sockets so both can run at once; the directory is the app's
 * own (`~/.solunivo`, next to the settings file) and private to the user.
 */
export const agentSocketPath = (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly packaged: boolean;
}): string =>
  options.env[AGENT_SOCKET_ENV] ??
  join(options.home, '.solunivo', 'run', options.packaged ? 'agent.sock' : 'agent-dev.sock');
