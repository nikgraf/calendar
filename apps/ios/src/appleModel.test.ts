import { describe, expect, it, vi } from 'vite-plus/test';

// A binary built without the pod: the package throws while being
// *evaluated*, exactly as TurboModuleRegistry.getEnforcing does. A static
// import of it would take the whole app down at launch, which is what a
// dev client built before this dependency actually does.
vi.mock('@react-native-ai/apple', () => {
  throw new Error("Invariant Violation: TurboModuleRegistry.getEnforcing('NativeAppleLLM')");
});

// …and without the availability module, which loads through Expo's registry.
vi.mock('expo-modules-core', () => ({
  requireNativeModule: () => {
    throw new Error("Cannot find native module 'SolunivoModelAvailability'");
  },
}));

describe('appleLanguageModel without the native module', () => {
  it('imports cleanly and reports the module as missing', async () => {
    const { appleLanguageModel } = await import('./appleModel.ts');
    // Not merely 'unavailable': the UI says the build lacks support,
    // whereas an unavailable model may become ready.
    await expect(appleLanguageModel.status()).resolves.toBe('missing-module');
    await expect(appleLanguageModel.availability?.()).resolves.toEqual({
      status: 'missing-module',
    });
  });

  it('fails the generate call rather than crashing the app', async () => {
    const { appleLanguageModel } = await import('./appleModel.ts');
    await expect(appleLanguageModel.generateJson({ jsonSchema: {}, prompt: 'x' })).rejects.toThrow(
      /not built into this app/,
    );
  });
});
