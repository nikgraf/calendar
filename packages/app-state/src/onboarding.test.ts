import { DEFAULT_ONBOARDING_STATE } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { mergeOnboarding } from './onboarding.ts';

describe('mergeOnboarding', () => {
  it('lands a patch on the default before the first read resolved', () => {
    expect(mergeOnboarding(null, { card: 'collapsed' })).toEqual({
      ...DEFAULT_ONBOARDING_STATE,
      card: 'collapsed',
    });
  });

  it('keeps the marks and the setup outcome a caller does not know about', () => {
    const current = {
      card: 'expanded' as const,
      lessons: { create: 'done' as const },
      setup: 'skipped' as const,
    };
    expect(mergeOnboarding(current, { card: 'hidden' })).toEqual({
      card: 'hidden',
      lessons: { create: 'done' },
      setup: 'skipped',
    });
  });
});
