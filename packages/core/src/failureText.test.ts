import { Data } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { failureText } from './failureText.ts';

class Tagged extends Data.TaggedError('Tagged')<{ readonly message: string }> {}

describe('failureText', () => {
  it('keeps what String() says for errors and strings', () => {
    expect(failureText(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
    expect(failureText(new Tagged({ message: 'no token' }))).toBe('Tagged: no token');
    expect(failureText('ECONNRESET')).toBe('ECONNRESET');
    expect(failureText(3)).toBe('3');
    expect(failureText(null)).toBe('null');
  });

  it('spells out a plain object instead of [object Object]', () => {
    expect(failureText({ reason: 'quota', status: 403 })).toBe('{"reason":"quota","status":403}');
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(failureText(loop)).toBe('{"self":[Circular]}');
  });
});
