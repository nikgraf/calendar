import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { EventDto } from './dto.ts';
import { callTool } from './gateway.ts';
import { CalendarLevel, decideWrite, GuestsCapability } from './policy.ts';
import { agentWith, base, DAY, grantCalendar, iso, makeWorld } from './testing/harness.ts';

it.prop(
  'hidden, read-only and approval gates cannot be bypassed by other capabilities',
  {
    guests: GuestsCapability,
    level: CalendarLevel,
    providerWritable: Schema.Boolean,
    touchesGuests: Schema.Boolean,
  },
  (input) => {
    const original = decideWrite(input);
    expect(decideWrite({ ...input, level: 'none' })).toEqual({ _tag: 'Hidden' });
    expect(decideWrite({ ...input, providerWritable: false })._tag).not.toBe('Allow');
    for (const level of ['freeBusy', 'read', 'ask'] as const) {
      expect(decideWrite({ ...input, level })._tag).not.toBe('Allow');
    }
    if (input.touchesGuests) {
      expect(decideWrite({ ...input, guests: 'off' })._tag).not.toBe('Allow');
    }
    if (original._tag === 'Allow') {
      expect(input.level).toBe('write');
      expect(input.providerWritable).toBe(true);
      expect(!input.touchesGuests || input.guests === 'allow').toBe(true);
    }
  },
);

const levels = ['none', 'freeBusy', 'read', 'ask', 'write'] as const;

// Enumerate this finite space; random sampling could miss one of its 25 pairs.
it.effect.each(
  levels.flatMap((privateLevel) => levels.map((workLevel) => ({ privateLevel, workLevel }))),
)(
  'the gateway enforces work=$workLevel and private=$privateLevel',
  ({ privateLevel, workLevel }) => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = agentWith({
        calendars: [grantCalendar('work', workLevel), grantCalendar('private', privateLevel)],
      });
      const result = (yield* callTool(agent, 'list_events', {
        from: iso(base),
        to: iso(base + DAY),
      })) as { readonly events: ReadonlyArray<EventDto> };
      const expected = [
        ...(['read', 'ask', 'write'].includes(workLevel)
          ? ['Standup', 'Lunch with Ana', 'Weekly sync', 'Vendor pitch']
          : []),
        ...(['read', 'ask', 'write'].includes(privateLevel) ? ['Therapy'] : []),
      ];
      expect(result.events.map((event) => event.title).sort()).toEqual(expected.sort());
    }).pipe(Effect.provide(world.layer), Effect.scoped);
  },
);
