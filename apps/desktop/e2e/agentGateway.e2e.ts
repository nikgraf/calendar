import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { type AgentPolicy, EMPTY_POLICY } from '@calendar/agent';
import { Account, Attendee, CalendarInfo, EventRecord } from '@calendar/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  agentEnv,
  agentRelayPath,
  agentToken,
  type App,
  type CliResult,
  launchApp,
  readAgentRequests,
  readEvents,
  readPendingOps,
  runAgentCli,
} from './harness.ts';

// Other agents reach the app through the bundled relay — the real one,
// spawned as a child process against the launched app's socket — over the
// CLI and over MCP. Seeded relative to today (mid-day UTC, so local and
// UTC dates agree) and asserted on own ids only.
const POLL = { timeout: 15_000 };
const HOUR = 60 * 60 * 1000;
const ACCOUNT = 'acc-e2e';

const todayAt = (hour: number, minute = 0): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
};
const iso = (epochMs: number): string => new Date(epochMs).toISOString();
const today = { from: iso(todayAt(0)), to: iso(todayAt(24)) };

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'e2e@nikgraf.com',
  id: ACCOUNT,
  provider: 'google',
  status: 'ok',
  tasksEnabled: false,
});

const calendar = (id: string, summary: string, accessRole: CalendarInfo['accessRole'] = 'owner') =>
  new CalendarInfo({
    accessRole,
    accountId: ACCOUNT,
    colorHex: '#3b82f6',
    id,
    isPrimary: id === 'cal-work',
    isVisible: true,
    provider: 'google',
    summary,
    timeZone: 'UTC',
  });

const event = (
  id: string,
  calendarId: string,
  title: string,
  startUtc: number,
  extra: Partial<ConstructorParameters<typeof EventRecord>[0]> = {},
) =>
  new EventRecord({
    accountId: ACCOUNT,
    calendarId,
    endUtc: startUtc + HOUR,
    etag: '"1"',
    id,
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...extra,
  });

const seed = {
  accounts: [account],
  calendars: [
    calendar('cal-work', 'Work'),
    calendar('cal-private', 'Private'),
    calendar('cal-team', 'Team', 'reader'),
  ],
  // A fixed primary zone: the times the gateway prints do not depend on the machine.
  deviceSettings: { timeZones: { primary: 'UTC', zones: ['UTC'] } },
  events: [
    event('evt-standup', 'cal-work', 'Standup meeting', todayAt(9)),
    event('evt-lunch', 'cal-work', 'Lunch with Ana', todayAt(12), {
      attendees: [
        new Attendee({
          email: 'e2e@nikgraf.com',
          isOrganizer: true,
          isSelf: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'ana@example.com', responseStatus: 'accepted' }),
      ],
      organizerEmail: 'e2e@nikgraf.com',
    }),
    event('evt-therapy', 'cal-private', 'Therapy session', todayAt(14)),
    event('evt-offsite', 'cal-team', 'Team offsite', todayAt(16)),
  ],
};

const grant = (calendars: Record<string, AgentPolicy['calendarDefault']>): AgentPolicy => ({
  ...EMPTY_POLICY,
  calendars: Object.entries(calendars).map(([calendarId, level]) => ({
    accountId: ACCOUNT,
    calendarId,
    level,
  })),
});

const READER = agentToken('reader');
const WRITER = agentToken('writer');
const ASKER = agentToken('asker');

const agents = [
  {
    name: 'Reader',
    policy: grant({ 'cal-private': 'freeBusy', 'cal-work': 'read' }),
    token: READER,
  },
  { name: 'Writer', policy: grant({ 'cal-team': 'write', 'cal-work': 'write' }), token: WRITER },
  { name: 'Asker', policy: grant({ 'cal-work': 'ask' }), token: ASKER },
];

const json = <T>(result: CliResult): T => {
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as T;
};

const errorOf = (result: CliResult): { code: string; message: string } =>
  (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error;

interface Listed<T> {
  readonly calendars: ReadonlyArray<T>;
}
interface CalendarRow {
  readonly access: string;
  readonly name: string;
  readonly ref: string;
  readonly writable: boolean;
}

const calendarRef = async (app: App, token: string, name: string): Promise<string> => {
  const { calendars } = json<Listed<CalendarRow>>(
    await runAgentCli(app, token, ['list_calendars']),
  );
  const found = calendars.find((entry) => entry.name === name);
  expect(found, `calendar ${name}`).toBeDefined();
  return found!.ref;
};

const click = (cdp: App['cdp'], selector: string) =>
  cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.click()`);

/** Changes a <select> the way a user would, so React sees it. */
const choose = (cdp: App['cdp'], selector: string, value: string) =>
  cdp.eval(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

const newEvent = (
  calendar: string,
  title: string,
  hour: number,
  extra: ReadonlyArray<string> = [],
) => [
  'create_event',
  '--calendar',
  calendar,
  '--title',
  title,
  '--start',
  iso(todayAt(hour)),
  '--end',
  iso(todayAt(hour + 1)),
  ...extra,
];

/** The relay with nothing but a PATH: no token, no socket. */
const runBare = (args: ReadonlyArray<string>) =>
  new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, [agentRelayPath, ...args], {
      env: { PATH: process.env['PATH'] ?? '' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('close', (code) => resolve({ code: code ?? -1, stderr: '', stdout }));
  });

describe('agent gateway: other agents reach the app over the CLI and MCP', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, { agents });
    // The socket appears once the backend is up and found the seeded agents.
    const deadline = Date.now() + POLL.timeout;
    while (!existsSync(app.agentSocketPath)) {
      if (Date.now() > deadline) {
        throw new Error('the agent socket never appeared');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('listens on a socket only the user can open, and refuses an unknown token', async () => {
    expect(statSync(app.agentSocketPath).mode & 0o777).toBe(0o600);
    const refused = await runAgentCli(app, agentToken('nobody'), ['list_calendars']);
    expect(refused.code).toBe(3);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/Unknown agent token/u);
  });

  it('reads follow the grant: full details, free/busy only, or nothing', async () => {
    const { calendars } = json<Listed<CalendarRow>>(
      await runAgentCli(app, READER, ['list_calendars']),
    );
    expect(calendars.map((entry) => [entry.name, entry.access, entry.writable])).toEqual([
      ['Private', 'freeBusy', false],
      ['Work', 'read', false],
    ]);

    const listed = await runAgentCli(app, READER, [
      'list_events',
      '--from',
      today.from,
      '--to',
      today.to,
    ]);
    const titles = json<{ events: ReadonlyArray<{ title: string }> }>(listed).events.map(
      (entry) => entry.title,
    );
    expect(titles).toEqual(['Standup meeting', 'Lunch with Ana']);
    // Neither the free/busy-only calendar nor the ungranted one leaks a title.
    expect(listed.stdout).not.toMatch(/Therapy|offsite/u);

    const busy = json<{ busy: ReadonlyArray<{ end: string; start: string }> }>(
      await runAgentCli(app, READER, ['get_free_busy', '--from', today.from, '--to', today.to]),
    ).busy.map((block) => Date.parse(block.start));
    // The private 14:00 block counts as busy time; the ungranted 16:00 one does not exist.
    expect(busy).toEqual([todayAt(9), todayAt(12), todayAt(14)]);
  });

  it.each([
    ['the 2026-07-28 revision', { versionNegotiation: { mode: 'auto' } }, 'modern'],
    ['a 2025-era client', undefined, 'legacy'],
  ] as const)('serves MCP to %s through the relay', async (_label, options, era) => {
    const client = new Client({ name: 'e2e-agent', version: '0.0.1' }, options);
    await client.connect(
      new StdioClientTransport({
        args: [agentRelayPath, 'mcp'],
        command: process.execPath,
        env: agentEnv(app, READER),
        stderr: 'pipe',
      }),
    );
    try {
      expect(client.getProtocolEra()).toBe(era);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(15);
      expect(tools.find((tool) => tool.name === 'create_event')?.inputSchema).toMatchObject({
        required: ['calendar', 'title'],
      });

      const result = await client.callTool({ arguments: today, name: 'list_events' });
      const text = (result.content as ReadonlyArray<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toMatchObject({
        events: [{ title: 'Standup meeting' }, { title: 'Lunch with Ana' }],
      });

      // A refusal is a tool error the agent can read, not a broken connection.
      const refused = await client.callTool({
        arguments: { ...today, calendars: ['cal_bogus'] },
        name: 'list_events',
      });
      expect(refused.isError).toBe(true);
      expect((refused.content as ReadonlyArray<{ text: string }>)[0]!.text).toContain(
        'InvalidInput',
      );
    } finally {
      await client.close();
    }
  });

  it('a permitted write lands in the app, queues for Google and is logged', async () => {
    const work = await calendarRef(app, WRITER, 'Work');
    const created = json<{ event: { pendingSync?: boolean; title: string }; status: string }>(
      await runAgentCli(app, WRITER, newEvent(work, 'Agent dinner', 18, ['--location', 'Mochi'])),
    );
    expect(created).toMatchObject({
      event: { pendingSync: true, title: 'Agent dinner' },
      status: 'done',
    });

    await expect
      .poll(async () => (await readEvents(app.userDataDir)).map((row) => row.title), POLL)
      .toContain('Agent dinner');
    const ops = await readPendingOps(app.userDataDir);
    expect(ops.filter((op) => op.kind === 'create')).toHaveLength(1);
    // The open window repaints without a reload.
    await app.cdp.waitFor(`document.body.textContent.includes('Agent dinner')`);

    const log = await readAgentRequests(app.userDataDir);
    expect(log[0]).toMatchObject({
      agentName: 'Writer',
      status: 'done',
      summary: { title: 'Create event “Agent dinner”' },
      tool: 'create_event',
    });
  });

  it('refuses what the grant, the provider or the guests switch does not allow', async () => {
    const before = (await readEvents(app.userDataDir)).length;

    // Read-only grant.
    const readerWork = await calendarRef(app, READER, 'Work');
    const denied = await runAgentCli(app, READER, newEvent(readerWork, 'Nope', 19));
    expect(denied.code).toBe(1);
    expect(errorOf(denied).code).toBe('PermissionDenied');

    // No grant at all: the calendar does not exist for this agent, even with its real ref.
    const privateRef = await calendarRef(app, READER, 'Private');
    const missing = await runAgentCli(app, WRITER, newEvent(privateRef, 'Nope', 19));
    expect(errorOf(missing)).toMatchObject({ code: 'NotFound' });

    // A write grant on a calendar Google keeps read-only.
    const team = await calendarRef(app, WRITER, 'Team');
    const readOnly = await runAgentCli(app, WRITER, newEvent(team, 'Nope', 19));
    expect(errorOf(readOnly)).toMatchObject({ code: 'PermissionDenied' });
    expect(errorOf(readOnly).message).toMatch(/read-only at its provider/u);

    // Guests are off for this agent: no invitation, and no edit of an event that has guests.
    const work = await calendarRef(app, WRITER, 'Work');
    const invite = await runAgentCli(
      app,
      WRITER,
      newEvent(work, 'Nope', 19, ['--attendees', '[{"email":"ben@example.com"}]']),
    );
    expect(errorOf(invite).message).toMatch(/reaches other people/u);
    const events = json<{ events: ReadonlyArray<{ ref: string; title: string }> }>(
      await runAgentCli(app, WRITER, ['list_events', '--from', today.from, '--to', today.to]),
    ).events;
    const lunch = events.find((entry) => entry.title === 'Lunch with Ana')!;
    const retitle = await runAgentCli(app, WRITER, [
      'update_event',
      '--ref',
      lunch.ref,
      '--title',
      'Hijacked',
    ]);
    expect(errorOf(retitle).code).toBe('PermissionDenied');

    // Bad input is a usage error, not a crash.
    const invalid = await runAgentCli(app, WRITER, [
      'list_events',
      '--from',
      'whenever',
      '--to',
      'x',
    ]);
    expect(invalid.code).toBe(2);

    const rows = await readEvents(app.userDataDir);
    expect(rows).toHaveLength(before);
    expect(rows.map((row) => row.title)).not.toContain('Hijacked');
    // Refusals show up in the activity log; "not found" names nothing.
    const blocked = (await readAgentRequests(app.userDataDir)).filter(
      (row) => row.status === 'blocked',
    );
    expect(blocked.map((row) => row.agentName).sort()).toEqual([
      'Reader',
      'Writer',
      'Writer',
      'Writer',
    ]);
  });

  it('ask first: the write waits for the dialog, runs on Approve and not on Decline', async () => {
    const { cdp } = app;
    const work = await calendarRef(app, ASKER, 'Work');

    const approved = runAgentCli(app, ASKER, newEvent(work, 'Asked breakfast', 7));
    await cdp.waitFor(`!!document.querySelector('[data-testid="agent-approval"]')`);
    const dialog = await cdp.eval<string>(
      `document.querySelector('[data-testid="agent-approval"]').textContent`,
    );
    expect(dialog).toContain('Asker is asking');
    expect(dialog).toContain('Create event “Asked breakfast”');
    expect(dialog).toContain('Calendar: Work (e2e@nikgraf.com)');
    // Nothing is written while the question is open.
    expect((await readEvents(app.userDataDir)).map((row) => row.title)).not.toContain(
      'Asked breakfast',
    );

    // The buttons arm a moment after a request appears.
    await cdp.waitFor(
      `document.querySelector('[data-testid="agent-approve"]')?.disabled === false`,
    );
    await click(cdp, '[data-testid="agent-approve"]');
    expect(json<{ status: string }>(await approved).status).toBe('done');
    await expect
      .poll(async () => (await readEvents(app.userDataDir)).map((row) => row.title), POLL)
      .toContain('Asked breakfast');
    await cdp.waitFor(`!document.querySelector('[data-testid="agent-approval"]')`);

    const declined = runAgentCli(app, ASKER, newEvent(work, 'Asked brunch', 8));
    await cdp.waitFor(
      `document.querySelector('[data-testid="agent-approval-title"]')?.textContent.includes('Asked brunch')`,
    );
    await cdp.waitFor(`document.querySelector('[data-testid="agent-deny"]')?.disabled === false`);
    await click(cdp, '[data-testid="agent-deny"]');
    const result = await declined;
    expect(result.code).toBe(1);
    expect(errorOf(result).message).toMatch(/declined/u);
    expect((await readEvents(app.userDataDir)).map((row) => row.title)).not.toContain(
      'Asked brunch',
    );

    const asked = (await readAgentRequests(app.userDataDir)).filter(
      (row) => row.agentName === 'Asker',
    );
    expect(asked.map((row) => row.status)).toEqual(['denied', 'done']);
  });

  it('Escape closes only the request on top, and the calendar ignores keys behind it', async () => {
    const { cdp } = app;
    const work = await calendarRef(app, ASKER, 'Work');
    const key = (init: string) =>
      cdp.eval(`void window.dispatchEvent(new KeyboardEvent('keydown', ${init}))`);
    const declineAll = async () => {
      for (const request of (
        await cdp.eval<{ pending: ReadonlyArray<{ id: string }> }>(
          `window.calendarBridge.agentsState()`,
        )
      ).pending) {
        await cdp.eval(`window.calendarBridge.agentsDecide(${JSON.stringify(request.id)}, 'deny')`);
      }
    };

    // A half-written event (⌘N), then a request on top of it.
    await key(`{ key: 'n', metaKey: true }`);
    await cdp.waitFor(`document.body.textContent.includes('New event')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('input[placeholder="Title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Half written');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const first = runAgentCli(app, ASKER, newEvent(work, 'Asked lunch', 12));
    await cdp.waitFor(`!!document.querySelector('[data-testid="agent-approval"]')`);

    // One Escape: the request goes, the draft stays.
    await cdp.pressEscape();
    await cdp.waitFor(`!document.querySelector('[data-testid="agent-approval"]')`);
    expect(
      await cdp.eval<string>(`document.querySelector('input[placeholder="Title"]')?.value ?? ''`),
    ).toBe('Half written');
    await cdp.pressEscape();
    await cdp.waitFor(`!document.body.textContent.includes('New event')`);

    // Behind a request, the calendar's own keys do nothing.
    const second = runAgentCli(app, ASKER, newEvent(work, 'Asked dinner', 19));
    await cdp.waitFor(
      `document.querySelector('[data-testid="agent-approval-title"]')?.textContent.includes('Asked dinner')`,
    );
    const title = await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`);
    await key(`{ key: 'ArrowRight' }`);
    await key(`{ key: 'k', metaKey: true }`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await cdp.eval<string>(`document.querySelector('h1')?.textContent ?? ''`)).toBe(title);
    expect(await cdp.eval<number>(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);

    await declineAll();
    expect((await first).code).toBe(1);
    expect((await second).code).toBe(1);
    await cdp.waitFor(`!document.querySelector('[data-testid="agent-approval"]')`);
  });

  it('Settings → Agents: answering one request disarms the next one sliding up', async () => {
    const work = await calendarRef(app, ASKER, 'Work');
    const first = runAgentCli(app, ASKER, newEvent(work, 'Asked lunch', 12));
    const second = runAgentCli(app, ASKER, newEvent(work, 'Asked dinner', 19));
    const settings = await app.openSettings('agents');
    try {
      const rows = `document.querySelectorAll('[data-testid="agent-pending-row"]')`;
      await settings.waitFor(`${rows}.length === 2`);
      await settings.waitFor(
        `[...document.querySelectorAll('[data-testid="agent-pending-approve"]')].every((button) => !button.disabled)`,
      );
      await click(settings, '[data-testid="agent-pending-approve"]');
      // The other request now sits where the click landed: not armed yet,
      // so a double click cannot approve it unread.
      await settings.waitFor(`${rows}.length === 1`);
      expect(
        await settings.eval<boolean>(
          `document.querySelector('[data-testid="agent-pending-approve"]').disabled`,
        ),
      ).toBe(true);
      await settings.waitFor(
        `document.querySelector('[data-testid="agent-pending-decline"]')?.disabled === false`,
      );
      await click(settings, '[data-testid="agent-pending-decline"]');
      // One approved, one declined — whichever the pane listed first.
      expect((await Promise.all([first, second])).map((result) => result.code).sort()).toEqual([
        0, 1,
      ]);
    } finally {
      await app.closeSettings();
    }
  });

  it('Settings → Agents: create an agent, grant it, and remove it', async () => {
    const cdp = await app.openSettings('agents');
    await cdp.waitFor(`!!document.querySelector('[data-testid="agents-section"]')`);
    // The seeded agents are listed (a retried run may also still show its own).
    const listed = await cdp.eval<Array<string>>(
      `[...document.querySelectorAll('[data-testid="agent-row"]')].map(row => row.dataset.agentName)`,
    );
    expect(listed).toEqual(expect.arrayContaining(agents.map((agent) => agent.name)));
    // The activity of the earlier tests is listed, newest first.
    await cdp.waitFor(
      `document.querySelector('[data-testid="agent-activity"]')?.textContent.includes('Asked breakfast')`,
    );

    // Unique per attempt, so a retry never trips over the previous one's agent.
    const name = `Hermes ${Date.now()}`;
    await cdp.type('[data-testid="agent-name"]', name);
    await click(cdp, '[data-testid="agent-create"]');
    const token = await cdp.waitFor<string>(
      `document.querySelector('[data-testid="agent-token"]')?.textContent`,
    );
    expect(token).toMatch(/^sol_[\w-]{43}$/u);
    const config = JSON.parse(
      await cdp.eval<string>(
        `document.querySelector('[data-testid="agent-mcp-config"]').textContent`,
      ),
    ) as { mcpServers: Record<string, { args: Array<string>; env: Record<string, string> }> };
    // The harness runs the app unpackaged, which names itself as a dev build.
    const entry = config.mcpServers['solunivo-dev'];
    expect(entry?.args.at(-1)).toBe('mcp');
    expect(entry?.env).toEqual({ SOLUNIVO_AGENT_TOKEN: token });

    // A new agent can connect and sees nothing.
    expect(json<Listed<CalendarRow>>(await runAgentCli(app, token, ['list_calendars']))).toEqual({
      calendars: [],
    });

    // Granting takes effect on the next call — no reconnect, no restart.
    await cdp.waitFor(`!!document.querySelector('[data-testid="agent-calendar-default"]')`);
    await choose(cdp, '[data-testid="agent-calendar-default"]', 'read');
    await choose(cdp, '[data-testid="agent-calendar-cal-private"]', 'none');
    await expect
      .poll(
        async () =>
          json<Listed<CalendarRow>>(
            await runAgentCli(app, token, ['list_calendars']),
          ).calendars.map((entry) => [entry.name, entry.access]),
        // Each probe is a real call: stay far below the per-agent rate limit.
        { ...POLL, interval: 500 },
      )
      .toEqual([
        ['Team', 'read'],
        ['Work', 'read'],
      ]);

    const row = `[data-agent-name="${name}"]`;
    const confirm = `${row} [data-testid="agent-confirm"]`;
    // A new token asks first; cancelling keeps the current one working.
    await click(cdp, `${row} [data-testid="agent-rotate"]`);
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(confirm)})?.textContent.includes('Replace the token for')`,
    );
    // The question and its consequence are the dialog's accessible name and
    // description: focus lands on Cancel, so that is what is announced.
    expect(
      await cdp.eval<Array<string | undefined>>(
        `(() => { const dialog = document.querySelector(${JSON.stringify(confirm)}); return ['aria-labelledby', 'aria-describedby'].map((attr) => document.getElementById(dialog.getAttribute(attr) ?? '')?.textContent); })()`,
      ),
    ).toEqual([
      `Replace the token for “${name}”?`,
      `The current token stops working now: ${name} cannot connect until you give it the new one.`,
    ]);
    await click(cdp, `${row} [data-testid="agent-confirm-no"]`);
    await cdp.waitFor(`!document.querySelector(${JSON.stringify(confirm)})`);
    expect((await runAgentCli(app, token, ['list_calendars'])).code).toBe(0);

    // So does a removal.
    await click(cdp, `${row} [data-testid="agent-remove"]`);
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(confirm)})?.textContent.includes('Remove “${name}”?')`,
    );
    await click(cdp, `${row} [data-testid="agent-confirm-yes"]`);
    await cdp.waitFor(`!document.querySelector(${JSON.stringify(row)})`);
    const gone = await runAgentCli(app, token, ['list_calendars']);
    expect(gone.code).toBe(3);
    await app.closeSettings();
  });

  it('the relay answers --version and --help without a token or a running app', async () => {
    expect((await runBare(['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+/u);
    expect((await runBare(['--help'])).stdout).toContain('solunivo-cli mcp');
    // A command without a token is refused before anything is contacted.
    expect((await runBare(['list_calendars'])).code).toBe(2);
  });
});
