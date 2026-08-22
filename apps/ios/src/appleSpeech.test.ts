import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({
  File: class {
    arrayBuffer = async () => new ArrayBuffer(8);
    delete = () => undefined;
  },
}));

// A binary built without the pod: the package throws while being
// evaluated, exactly as TurboModuleRegistry.getEnforcing does.
vi.mock('@react-native-ai/apple', () => {
  throw new Error(
    "Invariant Violation: TurboModuleRegistry.getEnforcing('NativeAppleTranscription')",
  );
});

describe('appleSpeech without the native module', () => {
  it('imports cleanly and reports itself unsupported', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await expect(appleSpeech.isSupported()).resolves.toBe(false);
  });

  it('fails prepare and transcribe rather than crashing the app', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await expect(appleSpeech.prepare()).rejects.toThrow(/not built into this app/);
    await expect(appleSpeech.transcribeFile('file:///tmp/x.wav')).rejects.toThrow(
      /not built into this app/,
    );
  });
});
