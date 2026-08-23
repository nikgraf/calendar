import { describe, expect, it } from 'vitest';
import { availabilityDetailFrom } from './appleModel.ts';

type Module = typeof import('@react-native-ai/apple');

// Only AppleFoundationModels is consulted; the rest of the module surface
// is irrelevant to the detail logic.
const moduleWith = (api: Record<string, unknown>) =>
  ({ AppleFoundationModels: api }) as unknown as Module;

describe('availabilityDetailFrom', () => {
  it("passes Apple's reason through verbatim", () => {
    const module = moduleWith({ availabilityStatus: () => 'modelNotReady' });
    expect(availabilityDetailFrom(module)).toBe('modelNotReady');
  });

  it('reports a build without the framework as missing-module', () => {
    expect(availabilityDetailFrom(undefined)).toBe('missing-module');
  });

  it('degrades to unknown on a binary predating the patched method', () => {
    // Our pnpm patch adds availabilityStatus; an old dev client running
    // newer JS from Metro is exactly this shape.
    expect(availabilityDetailFrom(moduleWith({ isAvailable: () => false }))).toBe('unknown');
  });

  it('degrades to unknown when the native call throws', () => {
    const module = moduleWith({
      availabilityStatus: () => {
        throw new Error('bridge failure');
      },
    });
    expect(availabilityDetailFrom(module)).toBe('unknown');
  });
});
