import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { thirdPartyNotices } from '../packages/core/src/thirdPartyNotices.ts';

describe('THIRD_PARTY_NOTICES.md', () => {
  it('is what the script writes from the acknowledgements the apps show', () => {
    // A difference: run `node scripts/third-party-notices.ts`.
    const file = readFileSync(join(import.meta.dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(file).toBe(thirdPartyNotices());
  });
});
