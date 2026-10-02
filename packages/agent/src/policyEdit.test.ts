import { describe, expect, it } from 'vitest';
import { calendarLevel, EMPTY_POLICY, taskListLevel } from './policy.ts';
import {
  calendarOverride,
  cliExample,
  mcpConfigSnippet,
  taskListOverride,
  withCalendarLevel,
  withTaskListLevel,
} from './policyEdit.ts';

const work = { accountId: 'a', calendarId: 'work' };
const inbox = { accountId: 'a', taskListId: 'inbox' };

describe('editing a grant', () => {
  it('sets, replaces and removes one calendar override without touching the rest', () => {
    const base = { ...EMPTY_POLICY, calendarDefault: 'read' as const, contacts: true };
    const granted = withCalendarLevel(base, work, 'write');
    expect(calendarOverride(granted, work)).toBe('write');
    expect(granted.contacts).toBe(true);

    const narrowed = withCalendarLevel(granted, work, 'none');
    expect(narrowed.calendars).toEqual([{ ...work, level: 'none' }]);
    // The same calendar id under another account is untouched.
    expect(calendarLevel(narrowed, { accountId: 'b', calendarId: 'work' })).toBe('read');

    const cleared = withCalendarLevel(narrowed, work, undefined);
    expect(cleared.calendars).toEqual([]);
    expect(calendarOverride(cleared, work)).toBeUndefined();
    expect(calendarLevel(cleared, work)).toBe('read');
  });

  it('does the same for task lists', () => {
    const granted = withTaskListLevel(EMPTY_POLICY, inbox, 'ask');
    expect(taskListOverride(granted, inbox)).toBe('ask');
    expect(taskListLevel(withTaskListLevel(granted, inbox, undefined), inbox)).toBe('none');
  });
});

describe('setup text for a new agent', () => {
  const packaged = {
    args: [],
    command: '/Applications/Solunivo.app/Contents/Resources/solunivo-cli',
    name: 'solunivo',
  };
  const dev = { args: ['/Users/n g/dist/cli.mjs'], command: 'node', name: 'solunivo-dev' };

  it('is the mcpServers entry with the token in env, never in args', () => {
    const config = JSON.parse(mcpConfigSnippet(packaged, 'sol_abc')) as {
      mcpServers: Record<string, { args: Array<string>; command: string; env: object }>;
    };
    expect(config.mcpServers).toEqual({
      solunivo: {
        args: ['mcp'],
        command: packaged.command,
        env: { SOLUNIVO_AGENT_TOKEN: 'sol_abc' },
      },
    });
  });

  it('names a dev build differently, so one agent can hold both entries', () => {
    const config = JSON.parse(mcpConfigSnippet(dev, 'sol_abc')) as {
      mcpServers: Record<string, { args: Array<string> }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['solunivo-dev']);
    expect(config.mcpServers['solunivo-dev']?.args).toEqual(['/Users/n g/dist/cli.mjs', 'mcp']);
  });

  it('quotes a path with spaces in the shell example', () => {
    expect(cliExample(dev, 'sol_abc')).toBe(
      "SOLUNIVO_AGENT_TOKEN=sol_abc node '/Users/n g/dist/cli.mjs' list_calendars",
    );
  });
});
