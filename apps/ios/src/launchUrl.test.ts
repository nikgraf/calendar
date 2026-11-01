import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const native = vi.hoisted(() => ({
  initial: null as string | null,
  linking: null as string | null,
}));

vi.mock('react-native', () => ({
  Linking: { getInitialURL: () => Promise.resolve(native.initial) },
}));
vi.mock('expo-linking', () => ({ getLinkingURL: () => native.linking }));

const { launchUrl } = await import('./launchUrl.ts');

describe('launchUrl', () => {
  beforeEach(() => {
    native.initial = null;
    native.linking = null;
  });

  it('is the URL that launched the app', async () => {
    native.initial = 'solunivo-dev://expo-sharing';
    native.linking = 'solunivo-dev://expo-sharing';
    await expect(launchUrl()).resolves.toBe('solunivo-dev://expo-sharing');
  });

  it("is the scene's URL when the app had started without one in the background", async () => {
    // React Native's launch options are the headless host's (no URL); the
    // scene that joined it brought the settings code.
    native.linking = 'solunivo:1:ABC';
    await expect(launchUrl()).resolves.toBe('solunivo:1:ABC');
  });

  it('is null when nothing opened the app', async () => {
    await expect(launchUrl()).resolves.toBeNull();
  });
});
