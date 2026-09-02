import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { backendMethodNames, makeDirectBackendClient, type BackendHandlers } from './backend.ts';

describe('backendMethodNames (derived from the rpc group)', () => {
  it('contains every request/response rpc and never the stream rpc', () => {
    // The derivation feeds the direct client and the handler layer — if it
    // silently came back empty or picked up the stream rpc, both would
    // break at runtime while still typechecking.
    expect(backendMethodNames).not.toContain('invalidations');
    expect(backendMethodNames.length).toBeGreaterThanOrEqual(23);
    for (const name of ['addAccount', 'createEvent', 'createTask', 'syncNow', 'updateTask']) {
      expect(backendMethodNames).toContain(name);
    }
  });

  it('makeDirectBackendClient exposes exactly the derived methods', async () => {
    const handlers = Object.fromEntries(
      backendMethodNames.map((name) => [name, () => Effect.succeed(name)]),
    ) as unknown as BackendHandlers;
    const client = makeDirectBackendClient(handlers, (effect) => Effect.runPromise(effect));
    expect(Object.keys(client).sort()).toEqual([...backendMethodNames].sort());
    // And the wrapping is live, not just present.
    const result = await Effect.runPromise(client.syncNow(undefined));
    expect(result).toBe('syncNow');
  });
});
