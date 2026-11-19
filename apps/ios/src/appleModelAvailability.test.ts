import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// The availability module's index reaches for the native module registry,
// which Node does not have; the check is handed its sources directly.
vi.mock('expo', () => ({
  requireNativeModule: () => {
    throw new Error("Cannot find native module 'SolunivoModelAvailability'");
  },
}));

const { AVAILABILITY_TIMEOUT_MS, availabilityOfReply, checkAvailability } =
  await import('./appleModel.ts');

// The package's model info, present: generation is built in.
const ai = (available: boolean) => ({
  getModelInfo: async () => ({ availability: available ? 'available' : 'modelNotReady' }),
});
/** The availability module, answering `reply`. */
const bridge = (reply: unknown) => ({ check: () => Promise.resolve(reply) });

describe('checkAvailability', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['appleIntelligenceNotEnabled', 'disabled'],
    ['modelNotReady', 'not-ready'],
    ['deviceNotEligible', 'unsupported'],
  ] as const)('maps %s onto %s and keeps the reason', async (reason, status) => {
    await expect(
      checkAvailability({ ai: ai(false), bridge: bridge({ reason, status: 'unavailable' }) }),
    ).resolves.toEqual({ nativeReason: reason, status });
  });

  it('is ready when Foundation Models says available', async () => {
    await expect(
      checkAvailability({ ai: ai(false), bridge: bridge({ status: 'available' }) }),
    ).resolves.toEqual({ status: 'ready' });
  });

  it('keeps a reason a newer iOS adds as unavailable, with its name', async () => {
    await expect(
      checkAvailability({
        ai: ai(true),
        bridge: bridge({ reason: 'regionNotSupported', status: 'unavailable' }),
      }),
    ).resolves.toEqual({ nativeReason: 'regionNotSupported', status: 'unavailable' });
  });

  it('is unavailable without a reason when iOS names none', async () => {
    await expect(
      checkAvailability({ ai: ai(true), bridge: bridge({ status: 'unavailable' }) }),
    ).resolves.toEqual({ nativeReason: undefined, status: 'unavailable' });
  });

  it('reports a build without the package as missing the module, whatever else is there', async () => {
    await expect(
      checkAvailability({ ai: undefined, bridge: bridge({ status: 'available' }) }),
    ).resolves.toEqual({ status: 'missing-module' });
  });

  it('falls back to model info on a build without the availability module', async () => {
    await expect(checkAvailability({ ai: ai(true), bridge: undefined })).resolves.toEqual({
      status: 'ready',
    });
    await expect(checkAvailability({ ai: ai(false), bridge: undefined })).resolves.toEqual({
      nativeReason: 'modelNotReady',
      status: 'not-ready',
    });
  });

  it('keeps both native argument slots before the promise callbacks', async () => {
    const getModelInfo = vi.fn(async () => ({ availability: 'available' }));
    await expect(checkAvailability({ ai: { getModelInfo }, bridge: undefined })).resolves.toEqual({
      status: 'ready',
    });
    // React Native positions the native resolve/reject callbacks after the
    // actual JS arguments, including these two optional strings.
    expect(getModelInfo).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
  });

  it('reports model info that rejects as a failed check', async () => {
    await expect(
      checkAvailability({
        ai: {
          getModelInfo: async () => {
            throw new Error('turbo module not ready');
          },
        },
        bridge: undefined,
      }),
    ).resolves.toEqual({
      checkError: 'turbo module not ready',
      reasonsUnavailable: true,
      status: 'unavailable',
    });
  });

  it('gives up on model info that never answers', async () => {
    vi.useFakeTimers();
    const result = checkAvailability({
      ai: { getModelInfo: () => new Promise<never>(() => {}) },
      bridge: undefined,
    });
    await vi.advanceTimersByTimeAsync(AVAILABILITY_TIMEOUT_MS);
    await expect(result).resolves.toEqual({
      checkError: 'iOS did not answer within 5 s.',
      reasonsUnavailable: true,
      status: 'unavailable',
    });
  });

  it.each([null, {}, { availability: true }, { availability: '' }])(
    'reports malformed model info as a failed check: %j',
    async (reply) => {
      await expect(
        checkAvailability({ ai: { getModelInfo: async () => reply }, bridge: undefined }),
      ).resolves.toMatchObject({
        checkError: expect.stringContaining('Unexpected reply'),
        status: 'unavailable',
      });
    },
  );

  it('reports a rejected check as failed, not as an unavailable model', async () => {
    await expect(
      checkAvailability({
        ai: ai(true),
        bridge: { check: () => Promise.reject(new Error('XPC connection interrupted')) },
      }),
    ).resolves.toEqual({ checkError: 'XPC connection interrupted', status: 'unavailable' });
  });

  it('gives up on a check that does not answer within its limit', async () => {
    vi.useFakeTimers();
    const result = checkAvailability({
      ai: ai(true),
      bridge: { check: () => new Promise<never>(() => {}) },
    });
    await vi.advanceTimersByTimeAsync(AVAILABILITY_TIMEOUT_MS);
    await expect(result).resolves.toEqual({
      checkError: 'iOS did not answer within 5 s.',
      status: 'unavailable',
    });
  });
});

describe('availabilityOfReply', () => {
  it('reads a reply of any other shape as a failed check', () => {
    expect(availabilityOfReply(null)).toMatchObject({ status: 'unavailable' });
    expect(availabilityOfReply(null).checkError).toContain('Unexpected reply');
    expect(availabilityOfReply({ status: 'maybe' }).checkError).toContain('"maybe"');
  });

  it('ignores an empty reason', () => {
    expect(availabilityOfReply({ reason: '', status: 'unavailable' })).toEqual({
      nativeReason: undefined,
      status: 'unavailable',
    });
  });
});
