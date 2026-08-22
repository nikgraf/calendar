import { describe, expect, it, vi } from 'vitest';

// A binary built without the pod: the package throws while being
// *evaluated*, exactly as TurboModuleRegistry.getEnforcing does. A static
// import of it would take the whole app down at launch, which is what a
// dev client built before this dependency actually does.
vi.mock('@react-native-ai/apple', () => {
  throw new Error("Invariant Violation: TurboModuleRegistry.getEnforcing('NativeAppleLLM')");
});

describe('appleLanguageModel without the native module', () => {
  it('imports cleanly and reports itself unavailable', async () => {
    const { appleLanguageModel } = await import('./appleModel.ts');
    await expect(appleLanguageModel.isAvailable()).resolves.toBe(false);
  });

  it('fails the generate call rather than crashing the app', async () => {
    const { appleLanguageModel } = await import('./appleModel.ts');
    await expect(appleLanguageModel.generateJson({ jsonSchema: {}, prompt: 'x' })).rejects.toThrow(
      /not built into this app/,
    );
  });
});
