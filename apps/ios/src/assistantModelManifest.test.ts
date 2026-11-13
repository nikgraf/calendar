import { describe, expect, it } from 'vite-plus/test';

import { assistantModelManifest, PUBLISHED_MODEL, sizeLabel } from './assistantModelManifest.ts';

describe('assistantModelManifest', () => {
  it('fetches the published release when nothing points elsewhere', () => {
    expect(assistantModelManifest(undefined)).toBe(PUBLISHED_MODEL);
    expect(assistantModelManifest('  ')).toBe(PUBLISHED_MODEL);
    expect(PUBLISHED_MODEL.url).toBe(
      `https://github.com/nikgraf/calendar-models/releases/download/${PUBLISHED_MODEL.version}/${PUBLISHED_MODEL.file}`,
    );
    expect(PUBLISHED_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sizeLabel(PUBLISHED_MODEL.bytes)).toBe('834 MB');
  });

  it('takes a valid override, and the published release for one that is not', () => {
    const local = {
      bytes: 10,
      file: 'local.gguf',
      sha256: 'ab',
      url: 'http://127.0.0.1:8092/local.gguf',
      version: 'sim-1',
    };
    expect(assistantModelManifest(JSON.stringify(local))).toEqual(local);
    expect(assistantModelManifest('not json')).toBe(PUBLISHED_MODEL);
    expect(assistantModelManifest(JSON.stringify({ ...local, bytes: '10' }))).toBe(PUBLISHED_MODEL);
  });
});
