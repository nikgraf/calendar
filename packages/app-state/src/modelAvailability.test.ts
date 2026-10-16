import type { LanguageModel, ModelAvailability, ModelStatus } from '@calendar/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  type AvailabilityState,
  createAvailabilityChecker,
  NOT_READY_RECHECK_MS,
  readAvailability,
} from './modelAvailability.ts';

/** A model whose checks answer when the test says, in the order they were asked. */
const pendingModel = () => {
  const checks: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (availability: ModelAvailability) => void;
  }> = [];
  const model: LanguageModel = {
    availability: () =>
      new Promise<ModelAvailability>((resolve, reject) => checks.push({ reject, resolve })),
    generateJson: () => Promise.reject(new Error('not used')),
    status: () => Promise.reject(new Error('not used')),
  };
  return { checks, model };
};

/** A checker over `model` that records every state it publishes, at a clock the test moves. */
const checkerOf = (model: LanguageModel) => {
  const states: Array<AvailabilityState> = [];
  let clock = 1000;
  const checker = createAvailabilityChecker({
    model,
    now: () => clock,
    onChange: (state) => states.push(state),
  });
  return {
    checker,
    setClock: (at: number) => {
      clock = at;
    },
    states,
  };
};

/** Lets the answered check's promise chain run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const DISABLED: ModelAvailability = {
  nativeReason: 'appleIntelligenceNotEnabled',
  status: 'disabled',
};

describe('createAvailabilityChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the whole answer — what iOS said, and when', async () => {
    const { checks, model } = pendingModel();
    const { checker, setClock } = checkerOf(model);
    checker.request(false);
    expect(checker.getState().checking).toBe(true);
    setClock(5000);
    checks[0]!.resolve(DISABLED);
    await settle();
    expect(checker.getState()).toMatchObject({
      checking: false,
      last: { at: 5000, availability: DISABLED, manual: false },
      lastManual: null,
      manualPending: false,
    });
  });

  it('reports every Check Again, the same answer twice included', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(false);
    checks[0]!.resolve(DISABLED);
    await settle();

    checker.request(true);
    expect(checker.getState().manualPending).toBe(true);
    checks[1]!.resolve(DISABLED);
    await settle();
    const first = checker.getState().lastManual;
    expect(first).toMatchObject({ availability: DISABLED, manual: true });

    checker.request(true);
    checks[2]!.resolve(DISABLED);
    await settle();
    const second = checker.getState().lastManual;
    // Nothing changed in the answer, and still a new one the UI reports.
    expect(second?.availability).toEqual(first?.availability);
    expect(second?.id).toBeGreaterThan(first!.id);
    expect(second).not.toBe(first);
    expect(checker.getState().manualPending).toBe(false);
  });

  it('runs one check at a time, and once more after it for any requests meanwhile', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(false);
    checker.request(false);
    checker.request(true);
    checker.request(false);
    expect(checks).toHaveLength(1);
    // The tap is waiting behind the check that was already out.
    expect(checker.getState().manualPending).toBe(true);

    checks[0]!.resolve(DISABLED);
    await settle();
    expect(checks).toHaveLength(2);
    expect(checker.getState()).toMatchObject({ checking: true, last: { manual: false } });

    checks[1]!.resolve({ status: 'ready' });
    await settle();
    expect(checks).toHaveLength(2);
    // The later check, started after the requests, has the last word.
    expect(checker.getState()).toMatchObject({
      checking: false,
      last: { availability: { status: 'ready' }, manual: true },
      lastManual: { availability: { status: 'ready' } },
      manualPending: false,
    });
  });

  it('turns unavailable into ready on the next answer', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(false);
    checks[0]!.resolve(DISABLED);
    await settle();
    checker.request(true);
    checks[1]!.resolve({ status: 'ready' });
    await settle();
    expect(checker.getState().last?.availability.status).toBe('ready');
  });

  it('answers a check that threw as a failed check, not as an unavailable model', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(true);
    checks[0]!.reject(new Error('XPC connection interrupted'));
    await settle();
    expect(checker.getState()).toMatchObject({
      checking: false,
      lastManual: {
        availability: { checkError: 'XPC connection interrupted', status: 'unavailable' },
      },
      manualPending: false,
    });
  });

  it('checks a not-ready model again every 30 s, until it is ready', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(false);
    checks[0]!.resolve({ nativeReason: 'modelNotReady', status: 'not-ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(NOT_READY_RECHECK_MS - 1);
    expect(checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toHaveLength(2);

    checks[1]!.resolve({ status: 'ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(NOT_READY_RECHECK_MS * 3);
    expect(checks).toHaveLength(2);
  });

  it('keeps one poll when a foreground check comes in between', async () => {
    const { checks, model } = pendingModel();
    const { checker } = checkerOf(model);
    checker.request(false);
    checks[0]!.resolve({ status: 'not-ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(NOT_READY_RECHECK_MS / 2);
    checker.request(false);
    checks[1]!.resolve({ status: 'not-ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(NOT_READY_RECHECK_MS);
    expect(checks).toHaveLength(3);
  });

  it('lands nothing once disposed: no state, no poll, no new checks', async () => {
    const { checks, model } = pendingModel();
    const { checker, states } = checkerOf(model);
    checker.request(false);
    const published = states.length;
    checker.dispose();
    checks[0]!.resolve({ status: 'not-ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(NOT_READY_RECHECK_MS * 2);
    checker.request(true);
    expect(states).toHaveLength(published);
    expect(checks).toHaveLength(1);
    expect(checker.getState().last).toBeNull();
  });
});

/** A model with no detailed check, as the desktop's and the fixture are. */
const statusOnly = (status: () => Promise<ModelStatus>): LanguageModel => ({
  generateJson: () => Promise.reject(new Error('not used')),
  status,
});

describe('readAvailability', () => {
  it('falls back to the status of a model without the detailed check', async () => {
    await expect(readAvailability(statusOnly(async () => 'not-ready'))).resolves.toEqual({
      status: 'not-ready',
    });
  });

  it('never rejects: a status that threw is a failed check', async () => {
    await expect(
      readAvailability(
        statusOnly(async () => {
          throw new Error('helper gone');
        }),
      ),
    ).resolves.toEqual({ checkError: 'helper gone', status: 'unavailable' });
  });
});
