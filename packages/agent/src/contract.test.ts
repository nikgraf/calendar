import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { isToolName, isWriteTool, TOOL_NAMES, toolInputJsonSchema, TOOLS } from './contract.ts';

describe('tool contract', () => {
  it('is the curated set — nothing that reaches accounts, settings or the queue', () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      'create_event',
      'create_task',
      'delete_event',
      'delete_task',
      'find_free_slots',
      'get_free_busy',
      'get_request',
      'list_calendars',
      'list_events',
      'list_task_lists',
      'list_tasks',
      'respond_to_event',
      'search_contacts',
      'update_event',
      'update_task',
    ]);
    expect(isToolName('removeAccount')).toBe(false);
    expect(isToolName('toString')).toBe(false);
    expect(TOOL_NAMES.filter(isWriteTool)).toHaveLength(7);
    for (const name of TOOL_NAMES) {
      expect(TOOLS[name].name).toBe(name);
    }
  });

  it('advertises every input as a closed JSON Schema object', () => {
    for (const name of TOOL_NAMES) {
      const schema = toolInputJsonSchema(name);
      expect(schema).toMatchObject({ additionalProperties: false, type: 'object' });
      expect(schema['properties']).toBeTypeOf('object');
    }
    expect(toolInputJsonSchema('list_calendars')).toEqual({
      additionalProperties: false,
      properties: {},
      type: 'object',
    });
  });

  it('optional fields are simply optional; only clearable ones admit null', () => {
    const create = toolInputJsonSchema('create_event') as {
      properties: Record<string, Record<string, unknown>>;
      required: ReadonlyArray<string>;
    };
    expect(create.required).toEqual(['calendar', 'title']);
    expect(create.properties['location']).toEqual({
      description: 'Where it takes place (free text).',
      type: 'string',
    });
    // Nested objects are closed too.
    expect(JSON.stringify(create.properties['attendees'])).toContain(
      '"additionalProperties":false',
    );
    expect(JSON.stringify(create)).not.toContain('"null"');

    const update = toolInputJsonSchema('update_task') as {
      properties: Record<string, unknown>;
    };
    expect(JSON.stringify(update.properties['dueTime'])).toContain('"null"');
    expect(JSON.stringify(update.properties['title'])).not.toContain('"null"');
  });

  it('the decoder agrees with the schema: unknown and null-for-optional are rejected', () => {
    const decode = Schema.decodeUnknownOption(TOOLS.create_event.input, {
      onExcessProperty: 'error',
    });
    const valid = { calendar: 'cal_x', start: '2026-10-01T10:00:00Z', title: 'T' };
    expect(decode(valid)._tag).toBe('Some');
    expect(decode({ ...valid, colour: 'red' })._tag).toBe('None');
    expect(decode({ ...valid, location: null })._tag).toBe('None');
    expect(decode({ start: 'x' })._tag).toBe('None');
  });
});
