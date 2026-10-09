import { describe, expect, it } from 'vite-plus/test';
import { parseToolArgs, runCli } from './cliRunner.ts';
import type { ToolCaller } from './mcp.ts';

const echo: ToolCaller = async (name, input) => ({ ok: true, result: { input, name } });

describe('parseToolArgs', () => {
  it('types each flag by the tool schema; kebab and camel case both work', () => {
    expect(
      parseToolArgs('find_free_slots', [
        '--duration-minutes',
        '45',
        '--fromDate=2026-10-01',
        '--to-date',
        '2026-10-03',
        '--days-of-week',
        '[1,2,3]',
      ]),
    ).toEqual({
      daysOfWeek: [1, 2, 3],
      durationMinutes: 45,
      fromDate: '2026-10-01',
      toDate: '2026-10-03',
    });
  });

  it('lists repeat or take JSON; booleans may stand alone; null clears', () => {
    expect(
      parseToolArgs('list_events', [
        '--from',
        '2026-10-01',
        '--to',
        '2026-10-02',
        '--calendars',
        'cal_a',
        '--calendars',
        'cal_b',
      ]),
    ).toMatchObject({ calendars: ['cal_a', 'cal_b'] });
    expect(
      parseToolArgs('create_event', [
        '--calendar',
        'cal_a',
        '--title',
        'Dinner',
        '--attendees',
        '[{"email":"ben@example.com"}]',
      ]),
    ).toMatchObject({ attendees: [{ email: 'ben@example.com' }], title: 'Dinner' });
    expect(parseToolArgs('update_task', ['--ref', 'task_x', '--completed'])).toEqual({
      completed: true,
      ref: 'task_x',
    });
    expect(
      parseToolArgs('update_task', [
        '--ref',
        'task_x',
        '--completed',
        'false',
        '--due-time',
        'null',
      ]),
    ).toEqual({ completed: false, dueTime: null, ref: 'task_x' });
  });

  it('--args supplies the whole input; later flags override it', () => {
    expect(
      parseToolArgs('create_task', [
        '--args',
        '{"list":"list_a","title":"A","dueDate":"2026-10-01"}',
        '--title',
        'B',
      ]),
    ).toEqual({ dueDate: '2026-10-01', list: 'list_a', title: 'B' });
  });

  it('refuses unknown flags, missing values and wrong types', () => {
    expect(() => parseToolArgs('list_calendars', ['--verbose'])).toThrow(/takes no inputs/u);
    expect(() => parseToolArgs('list_events', ['--form', 'x'])).toThrow(/It takes: /u);
    expect(() => parseToolArgs('list_events', ['--from'])).toThrow(/needs a value/u);
    expect(() => parseToolArgs('list_events', ['stray'])).toThrow(/Unexpected argument/u);
    expect(() => parseToolArgs('find_free_slots', ['--duration-minutes', 'long'])).toThrow(
      /expects a number/u,
    );
    expect(() => parseToolArgs('create_event', ['--attendees', 'ben'])).toThrow(/expects JSON/u);
    expect(() => parseToolArgs('create_event', ['--args', '[1]'])).toThrow(/JSON object/u);
  });
});

const refuse =
  (code: string): ToolCaller =>
  async () => ({ error: { code, message: 'no' }, ok: false });

describe('runCli', () => {
  it('calls the tool and prints its result as JSON', async () => {
    const reply = await runCli(['list-events', '--from', '2026-10-01', '--to', '2026-10-02'], echo);
    expect(reply).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(reply.stdout)).toEqual({
      input: { from: '2026-10-01', to: '2026-10-02' },
      name: 'list_events',
    });
  });

  it('lists the tools with their schemas, and prints usage', async () => {
    const tools = JSON.parse((await runCli(['tools'], echo)).stdout) as ReadonlyArray<{
      inputSchema: { type: string };
      kind: string;
      name: string;
    }>;
    expect(tools).toHaveLength(15);
    expect(tools.find((tool) => tool.name === 'delete_event')).toMatchObject({
      inputSchema: { type: 'object' },
      kind: 'destructive',
    });
    expect((await runCli([], echo)).stdout).toMatch(/solunivo-cli mcp/u);
    expect((await runCli(['help'], echo)).stdout).toMatch(/list_calendars/u);
  });

  it('exit codes: 2 for usage and invalid input, 1 for a refusal', async () => {
    expect(await runCli(['rm-rf'], echo)).toMatchObject({ exitCode: 2, stdout: '' });
    expect(await runCli(['list_events', '--nope', '1'], echo)).toMatchObject({ exitCode: 2 });

    const denied = await runCli(['list_calendars'], refuse('PermissionDenied'));
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stderr)).toEqual({
      error: { code: 'PermissionDenied', message: 'no' },
    });
    expect((await runCli(['list_calendars'], refuse('InvalidInput'))).exitCode).toBe(2);
  });
});
