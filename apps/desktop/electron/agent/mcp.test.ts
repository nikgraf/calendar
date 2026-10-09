import { TOOL_NAMES } from '@calendar/agent';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vite-plus/test';
import { MAX_LINE_BYTES } from './protocol.ts';
import { serveMcpSession, socketTransport, type ToolCaller } from './mcp.ts';

/** A connected client/server pair over the SDK's in-memory transport. */
const connect = async (
  call: ToolCaller,
  versionNegotiation?: ConstructorParameters<typeof Client>[1],
) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const session = serveMcpSession({ call, transport: serverSide, version: '1.2.3' });
  const client = new Client({ name: 'test-agent', version: '0.0.1' }, versionNegotiation);
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await session.close();
    },
  };
};

const textOf = (result: unknown): unknown => {
  const content = (result as { content: ReadonlyArray<{ text?: string; type: string }> }).content;
  return JSON.parse(content[0]?.text ?? 'null') as unknown;
};

const recorder = () => {
  const calls: Array<{ input: unknown; name: string }> = [];
  const call: ToolCaller = async (name, input) => {
    calls.push({ input, name });
    return name === 'delete_event'
      ? { error: { code: 'PermissionDenied', message: 'read only' }, ok: false }
      : { ok: true, result: { echoed: input, tool: name } };
  };
  return { call, calls };
};

describe.each([
  ['the 2026-07-28 revision', { versionNegotiation: { mode: { pin: '2026-07-28' } } }, 'modern'],
  ['a 2025-era client (initialize handshake)', undefined, 'legacy'],
] as const)('MCP over %s', (_label, options, era) => {
  it('negotiates the era and lists every tool with its schema and hints', async () => {
    const { call } = recorder();
    const { client, close } = await connect(call, options);
    expect(client.getProtocolEra()).toBe(era);
    expect(client.getServerVersion()).toMatchObject({ name: 'solunivo', version: '1.2.3' });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('create_event')?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['calendar', 'title'],
      type: 'object',
    });
    expect(byName.get('list_events')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('delete_task')?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    await close();
  });

  it('passes a call through untouched and reports a refusal as a tool error', async () => {
    const { call, calls } = recorder();
    const { client, close } = await connect(call, options);

    const input = { from: '2026-10-01', to: '2026-10-02' };
    const listed = await client.callTool({ arguments: input, name: 'list_events' });
    expect(textOf(listed)).toEqual({ echoed: input, tool: 'list_events' });
    expect(listed.isError).toBeFalsy();
    // Validation is the gateway's: even a malformed input reaches it as sent.
    await client.callTool({ arguments: { nonsense: true }, name: 'list_calendars' });
    expect(calls).toEqual([
      { input, name: 'list_events' },
      { input: { nonsense: true }, name: 'list_calendars' },
    ]);

    const refused = await client.callTool({ arguments: { ref: 'evt_x' }, name: 'delete_event' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toEqual({
      error: { code: 'PermissionDenied', message: 'read only' },
    });
    await close();
  });
});

describe('socketTransport', () => {
  it('takes the connection down with it when a message is too large', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let closed = 0;
    const session = serveMcpSession({
      call: recorder().call,
      transport: socketTransport(input, output, () => {
        closed += 1;
      }),
      version: '1.2.3',
    });
    // One "line" that never ends and is larger than a message may be.
    input.write(Buffer.alloc(MAX_LINE_BYTES + 1024, 0x61));
    await expect.poll(() => closed, { timeout: 2000 }).toBeGreaterThan(0);
    await session.close();
  });

  it('tells the owner when the peer hangs up', async () => {
    const input = new PassThrough();
    let closed = 0;
    serveMcpSession({
      call: recorder().call,
      transport: socketTransport(input, new PassThrough(), () => {
        closed += 1;
      }),
      version: '1.2.3',
    });
    input.end();
    await expect.poll(() => closed, { timeout: 2000 }).toBeGreaterThan(0);
  });
});
