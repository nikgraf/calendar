import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentChange,
  AgentPolicy,
  agentErrorJson,
  AgentSignals,
  type AgentsState,
  agentStoreLayer,
  authenticate,
  callTool,
  createAgent,
  decideRequest,
  type GatewayServices,
  listAgents,
  listPendingRequests,
  listRequests,
  recoverInterruptedRequests,
  removeAgent,
  rotateAgentToken,
  sweepRequests,
  toRequestView,
  updateAgent,
} from '@calendar/agent';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, Notification } from 'electron';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import type { BackendHost } from '../backendHost.ts';
import { isOwnPage, showMainWindow } from '../windows.ts';
import { runCli } from './cliRunner.ts';
import { serveMcpSession, socketTransport, type ToolCaller, type ToolOutcome } from './mcp.ts';
import { agentSocketPath } from './protocol.ts';
import { makeRateLimiter } from './rateLimit.ts';
import { type AgentSocketServer, startAgentSocketServer } from './socketServer.ts';

/**
 * Hosts the agent gateway in the main process: the agent store
 * (userData/agents.db), the Unix socket other agents connect to, and the
 * Settings UI's `agents:*` IPC. Tool calls run against the same backend
 * runtime the renderer's rpc uses, through @calendar/agent's enforcement.
 *
 * The socket only exists while at least one agent does. Like the settings
 * file, the e2e harness points CALENDAR_AGENT_SOCKET under its temp
 * profile: a run must never listen in a developer's ~/.solunivo.
 */

const CALLS_PER_MINUTE = 120;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVITY_SHOWN = 30;
const BLOCKED_SHOWN = 10;
const MAX_NAME_INPUT = 200;

const log = (message: string, detail?: unknown): void =>
  console.log(`[agents] ${message}`, detail ?? '');

const decodePolicy = Schema.decodeUnknownSync(AgentPolicy);

/** How an agent starts the relay: the bundled wrapper, or the built script in a dev checkout. */
const relayCommand = (): AgentsState['command'] =>
  app.isPackaged
    ? { args: [], command: join(process.resourcesPath, 'solunivo-cli') }
    : {
        args: [fileURLToPath(new URL('cli.mjs', import.meta.url))],
        command: 'node',
      };

const broadcast = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agents:changed');
  }
};

const announce = (change: Extract<AgentChange, { type: 'approvalRequested' }>): void => {
  if (process.env['CALENDAR_NOTIFICATIONS'] === 'off' || !Notification.isSupported()) {
    return;
  }
  const notification = new Notification({
    body: change.request.summary.title,
    title: `${change.request.agentName} is asking to make a change`,
  });
  // The approval dialog is the window's: a click opens one if none is there.
  notification.on('click', showMainWindow);
  notification.show();
};

/** Only this app's own page may manage agents. */
const trusted = (event: IpcMainInvokeEvent): void => {
  if (!event.senderFrame || !isOwnPage(event.senderFrame.url)) {
    throw new Error('agents: untrusted sender');
  }
};
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_INPUT) {
    throw new Error(`agents: invalid ${what}`);
  }
  return value;
};

export const startAgentHost = (backend: BackendHost): void => {
  const socketPath = agentSocketPath({
    env: process.env,
    home: homedir(),
    packaged: app.isPackaged,
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      agentStoreLayer.pipe(
        Layer.provide(SqliteClient.layer({ filename: join(app.getPath('userData'), 'agents.db') })),
      ),
      AgentSignals.layer,
    ),
  );
  const agentContext = runtime.context();
  /** Agent services from this runtime, everything else from the backend's. */
  const run = async <A, E>(effect: Effect.Effect<A, E, GatewayServices>): Promise<A> =>
    backend.run(Effect.provideContext(effect, await agentContext));

  const limiter = makeRateLimiter(CALLS_PER_MINUTE, 60_000);

  /**
   * One tool call for a token. The agent is looked up on every call, so a
   * changed grant, a replaced token or a removed agent applies to the next
   * request of a connection that is already open.
   */
  const callFor =
    (token: string): ToolCaller =>
    async (name, input): Promise<ToolOutcome> => {
      try {
        return await run(
          Effect.gen(function* () {
            const agent = yield* authenticate(token);
            if (!agent) {
              return {
                error: {
                  code: 'Unauthorized',
                  message: 'This agent was removed or its token was replaced.',
                },
                ok: false as const,
              };
            }
            if (!limiter.take(agent.id)) {
              return {
                error: {
                  code: 'RateLimited',
                  message: `More than ${CALLS_PER_MINUTE} calls in a minute; slow down.`,
                },
                ok: false as const,
              };
            }
            const result = yield* Effect.result(callTool(agent, name, input));
            return result._tag === 'Success'
              ? { ok: true as const, result: result.success }
              : { error: agentErrorJson(result.failure), ok: false as const };
          }),
        );
      } catch (error) {
        log('tool call failed', String(error));
        return { error: { code: 'Failed', message: 'Solunivo could not run this.' }, ok: false };
      }
    };

  let server: AgentSocketServer | undefined;
  let socketError: string | undefined;

  const openSocket = async (): Promise<void> => {
    try {
      server = await startAgentSocketServer(
        socketPath,
        {
          authenticate: async (token) => (await run(authenticate(token)))?.id,
          runCli: (token, argv) => runCli(argv, callFor(token)),
          serveMcp: ({ input, output, socket, token }) => {
            const session = serveMcpSession({
              call: callFor(token),
              onError: (error) => log('mcp session error', error.message),
              // A session that ends on its own (an oversize message) takes its socket with it.
              transport: socketTransport(input, output, () => socket.destroy()),
              version: app.getVersion(),
            });
            socket.once('close', () => void session.close().catch(() => {}));
          },
        },
        { log },
      );
      socketError = undefined;
    } catch (error) {
      socketError = error instanceof Error ? error.message : String(error);
      console.warn('[agents] could not open the agent socket:', socketError);
    }
  };

  /** Listens exactly while there is an agent to listen for. One change at a time. */
  let syncing: Promise<void> = Promise.resolve();
  const syncSocket = (): Promise<void> => {
    // The chain never rejects: one failed pass must not stop every later one.
    syncing = syncing
      .then(async () => {
        const count = (await run(listAgents)).length;
        if (count > 0 && !server) {
          await openSocket();
        } else if (count === 0 && server) {
          const closing = server;
          server = undefined;
          await closing.close();
          log('no agents left; socket closed');
        }
      })
      .catch((error: unknown) => log('socket sync failed', String(error)));
    return syncing;
  };

  const state = async (): Promise<AgentsState> => {
    const [agents, pending, recent] = await Promise.all([
      run(listAgents),
      run(listPendingRequests),
      run(listRequests(500)),
    ]);
    // Refusals get their own small share of the list, so a burst of them
    // cannot scroll what an agent actually changed out of sight.
    const finished = recent.filter((request) => request.status !== 'pending');
    const shown = [
      ...finished.filter((request) => request.status !== 'blocked').slice(0, ACTIVITY_SHOWN),
      ...finished.filter((request) => request.status === 'blocked').slice(0, BLOCKED_SHOWN),
    ].sort((a, b) => b.createdAt - a.createdAt);
    return {
      activity: shown.map(toRequestView),
      agents,
      command: relayCommand(),
      ...(socketError === undefined ? {} : { error: socketError }),
      listening: server !== undefined,
      pending: pending.map(toRequestView),
      socketPath,
    };
  };

  const updateBadge = async (): Promise<void> => {
    const waiting = (await run(listPendingRequests)).length;
    app.dock?.setBadge(waiting > 0 ? String(waiting) : '');
  };

  const onChange = (change: AgentChange): void => {
    if (change.type === 'agents') {
      void syncSocket().then(broadcast);
      return;
    }
    if (change.type === 'approvalRequested') {
      announce(change);
    }
    void updateBadge().catch(() => {});
    broadcast();
  };

  ipcMain.handle('agents:state', (event) => {
    trusted(event);
    return state();
  });
  ipcMain.handle('agents:create', async (event, name: unknown) => {
    trusted(event);
    const created = await run(createAgent(text(name, 'name')));
    await syncing;
    return created;
  });
  ipcMain.handle('agents:update', async (event, id: unknown, changes: unknown) => {
    trusted(event);
    const { name, policy } = (changes ?? {}) as { name?: unknown; policy?: unknown };
    return run(
      updateAgent(text(id, 'id'), {
        ...(name === undefined ? {} : { name: text(name, 'name') }),
        ...(policy === undefined ? {} : { policy: decodePolicy(policy) }),
      }),
    );
  });
  ipcMain.handle('agents:rotate', async (event, id: unknown) => {
    trusted(event);
    const agentId = text(id, 'id');
    const token = await run(rotateAgentToken(agentId));
    server?.disconnect(agentId);
    return token === undefined ? null : { token };
  });
  ipcMain.handle('agents:remove', async (event, id: unknown) => {
    trusted(event);
    const agentId = text(id, 'id');
    server?.disconnect(agentId);
    await run(removeAgent(agentId));
    await syncing;
  });
  ipcMain.handle('agents:decide', async (event, requestId: unknown, decision: unknown) => {
    trusted(event);
    if (decision !== 'approve' && decision !== 'deny') {
      throw new Error('agents: invalid decision');
    }
    const settled = await run(decideRequest(text(requestId, 'request id'), decision));
    return settled ? toRequestView(settled) : null;
  });

  backend.ready
    .then(async () => {
      const signals = await run(Effect.map(AgentSignals, (service) => service));
      signals.subscribe(onChange);
      await run(recoverInterruptedRequests);
      await run(sweepRequests);
      setInterval(() => void run(sweepRequests).catch(() => {}), SWEEP_INTERVAL_MS).unref();
      await syncSocket();
      await updateBadge();
      broadcast();
    })
    .catch((error: unknown) => {
      console.error('[agents] start failed:', error);
    });

  app.on('will-quit', () => {
    if (server) {
      try {
        unlinkSync(server.path);
      } catch {
        // Already gone.
      }
    }
  });
};
