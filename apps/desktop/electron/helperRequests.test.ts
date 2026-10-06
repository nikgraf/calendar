import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELPER_TIMED_OUT, makeHelperRequests, PROBE_TIMEOUT_MS } from './helperRequests.ts';

/** A helper that answers only when the test says so. */
const fakeHelper = () => {
  const written: Array<{ readonly id: number; readonly method: string }> = [];
  let kills = 0;
  const requests = makeHelperRequests({
    kill: () => {
      kills += 1;
    },
    timeoutFor: (method) => (method === 'geo.search' ? 10_000 : 600_000),
    write: (line) => {
      written.push(JSON.parse(line) as { id: number; method: string });
    },
  });
  const answer = (method: string, result: unknown = 'ok') => {
    const request = written.find((entry) => entry.method === method);
    requests.receive(JSON.stringify({ id: request!.id, result }));
  };
  return { answer, kills: () => kills, requests, written };
};

describe('makeHelperRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a slow request times out alone while the helper still answers', async () => {
    const helper = fakeHelper();
    // A permission prompt waits on the user while a place search stalls.
    const prompt = helper.requests.call('reminders.requestAccess');
    const search = helper.requests.call('geo.search', { query: 'Caf' });
    const searchFailed = expect(search).rejects.toThrow(HELPER_TIMED_OUT);

    await vi.advanceTimersByTimeAsync(10_000);
    await searchFailed;
    // Asked whether the helper still answers, and it does.
    expect(helper.written.map((entry) => entry.method)).toEqual([
      'reminders.requestAccess',
      'geo.search',
      'status',
    ]);
    helper.answer('status', { status: 'ready' });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(helper.kills()).toBe(0);

    helper.answer('reminders.requestAccess', { granted: true });
    await expect(prompt).resolves.toEqual({ granted: true });
  });

  it('kills a helper that answers nothing, probe included', async () => {
    const helper = fakeHelper();
    const search = helper.requests.call('geo.search');
    const other = helper.requests.call('geo.search');
    const failed = Promise.all([
      expect(search).rejects.toThrow(HELPER_TIMED_OUT),
      expect(other).rejects.toThrow(HELPER_TIMED_OUT),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    // Two timeouts at once still send one probe.
    expect(helper.written.filter((entry) => entry.method === 'status')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(helper.kills()).toBe(1);
  });

  it('settles answers and errors by id, reports events, ignores noise', async () => {
    const helper = fakeHelper();
    const first = helper.requests.call('reminders.list');
    const second = helper.requests.call('reminders.listLists');
    helper.requests.receive(JSON.stringify({ error: 'denied', id: helper.written[1]!.id }));
    await expect(second).rejects.toThrow('denied');
    expect(helper.requests.receive(JSON.stringify({ event: 'reminders.changed' }))).toBe(
      'reminders.changed',
    );
    expect(helper.requests.receive('not json')).toBeUndefined();
    helper.answer('reminders.list', []);
    await expect(first).resolves.toEqual([]);
  });

  it('fails what is still waiting when the helper exits', async () => {
    const helper = fakeHelper();
    const waiting = helper.requests.call('transcribe');
    helper.requests.failAll('model helper exited');
    await expect(waiting).rejects.toThrow('model helper exited');
  });
});
