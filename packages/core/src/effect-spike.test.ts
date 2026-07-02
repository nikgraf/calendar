// M0 spike: minimal effect v4 program — fibers, Schedule, and Schema — the
// primitives the sync engine and domain models are built on.
import { describe, expect, it } from 'vitest';
import { Effect, Schedule, Schema } from 'effect';

describe('effect v4 spike', () => {
  it('runs a retried, scheduled effect', async () => {
    let attempts = 0;
    const flaky = Effect.suspend(() => {
      attempts += 1;
      return attempts < 3 ? Effect.fail(new Error('transient')) : Effect.succeed('ok');
    });

    const result = await Effect.runPromise(Effect.retry(flaky, Schedule.recurs(5)));
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('decodes with Schema', () => {
    const Event = Schema.Struct({
      id: Schema.String,
      title: Schema.String,
    });
    const decoded = Schema.decodeUnknownSync(Event)({
      id: 'abc',
      title: 'Standup',
    });
    expect(decoded.title).toBe('Standup');
  });
});
