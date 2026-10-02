import type { AgentPolicy, CalendarLevel, GuestsCapability, TaskListLevel } from './policy.ts';

/**
 * What the Settings UI needs to edit a grant and to hand a new agent its
 * setup. Pure, and free of everything but the policy types: the renderer
 * imports this file directly.
 */

export const CALENDAR_LEVELS: ReadonlyArray<CalendarLevel> = [
  'none',
  'freeBusy',
  'read',
  'ask',
  'write',
];
export const TASK_LIST_LEVELS: ReadonlyArray<TaskListLevel> = ['none', 'read', 'ask', 'write'];
export const GUESTS_OPTIONS: ReadonlyArray<GuestsCapability> = ['off', 'ask', 'allow'];

export const LEVEL_LABEL: Record<CalendarLevel, string> = {
  ask: 'Read, ask before writing',
  freeBusy: 'Free/busy only',
  none: 'No access',
  read: 'Read',
  write: 'Read and write',
};

export const GUESTS_LABEL: Record<GuestsCapability, string> = {
  allow: 'Allowed',
  ask: 'Ask me first',
  off: 'Not allowed',
};

/** Sets one calendar's level; `undefined` removes the override (back to the default). */
export const withCalendarLevel = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly calendarId: string },
  level: CalendarLevel | undefined,
): AgentPolicy => {
  const others = policy.calendars.filter(
    (grant) => grant.accountId !== target.accountId || grant.calendarId !== target.calendarId,
  );
  return {
    ...policy,
    calendars: level === undefined ? others : [...others, { ...target, level }],
  };
};

export const withTaskListLevel = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly taskListId: string },
  level: TaskListLevel | undefined,
): AgentPolicy => {
  const others = policy.taskLists.filter(
    (grant) => grant.accountId !== target.accountId || grant.taskListId !== target.taskListId,
  );
  return {
    ...policy,
    taskLists: level === undefined ? others : [...others, { ...target, level }],
  };
};

/** The override on one calendar, or undefined when it follows the default. */
export const calendarOverride = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly calendarId: string },
): CalendarLevel | undefined =>
  policy.calendars.find(
    (grant) => grant.accountId === target.accountId && grant.calendarId === target.calendarId,
  )?.level;

export const taskListOverride = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly taskListId: string },
): TaskListLevel | undefined =>
  policy.taskLists.find(
    (grant) => grant.accountId === target.accountId && grant.taskListId === target.taskListId,
  )?.level;

export interface RelayCommand {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  /**
   * The server's name in an agent's MCP configuration. The packaged app
   * and a dev build differ, so one agent can be connected to both.
   */
  readonly name: string;
}

/** The entry an agent's MCP configuration needs (the common `mcpServers` shape). */
export const mcpConfigSnippet = (relay: RelayCommand, token: string): string =>
  JSON.stringify(
    {
      mcpServers: {
        // In the order people expect to read it: command, args, env.
        [relay.name]: Object.fromEntries([
          ['command', relay.command],
          ['args', [...relay.args, 'mcp']],
          ['env', { SOLUNIVO_AGENT_TOKEN: token }],
        ]),
      },
    },
    null,
    2,
  );

const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** A first command to try from a shell. */
export const cliExample = (relay: RelayCommand, token: string): string =>
  [
    `SOLUNIVO_AGENT_TOKEN=${shellQuote(token)}`,
    shellQuote(relay.command),
    ...relay.args.map(shellQuote),
    'list_calendars',
  ].join(' ');
