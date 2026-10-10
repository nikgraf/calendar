import { describe, expect, it } from 'vite-plus/test';
import { modelStatusOf } from './desktopModel.ts';
import { modelUnavailableCopy } from './modelUnavailableCopy.ts';

describe('modelStatusOf', () => {
  it('maps the helper reply onto the reason the user can act on', () => {
    expect(modelStatusOf({ status: 'ready' })).toBe('ready');
    expect(modelStatusOf({ detail: 'appleIntelligenceNotEnabled', status: 'unavailable' })).toBe(
      'disabled',
    );
    expect(modelStatusOf({ detail: 'modelNotReady', status: 'unavailable' })).toBe('not-ready');
    expect(modelStatusOf({ detail: 'deviceNotEligible', status: 'unavailable' })).toBe(
      'unsupported',
    );
    expect(modelStatusOf({ detail: 'osTooOld', status: 'unavailable' })).toBe('unsupported');
  });

  it('keeps a reason it does not know as the generic unavailable', () => {
    expect(modelStatusOf({ detail: 'helperUnavailable', status: 'unavailable' })).toBe(
      'unavailable',
    );
    expect(modelStatusOf({ detail: 'constructor', status: 'unavailable' })).toBe('unavailable');
    expect(modelStatusOf({ status: 'unavailable' })).toBe('unavailable');
  });
});

describe('modelUnavailableCopy', () => {
  it('tells the user to switch Apple Intelligence on when it is off', () => {
    expect(modelUnavailableCopy('disabled').short).toBe('Turn on Apple Intelligence');
    expect(modelUnavailableCopy('disabled').long).toContain('System Settings');
  });

  it('says the generic line while the check is out or the reason is unknown', () => {
    expect(modelUnavailableCopy(null)).toEqual(modelUnavailableCopy('unavailable'));
    expect(modelUnavailableCopy('missing-module')).toEqual(modelUnavailableCopy('unavailable'));
  });
});
