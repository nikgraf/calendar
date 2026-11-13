import { describe, expect, it } from 'vite-plus/test';
import { contentOf } from './server.ts';

describe('contentOf', () => {
  it('reads the answer of a chat completion, and refuses what is not one', () => {
    const answer = '{"kind":"event","title":"Lunch","date":"2026-11-14","startTime":"13:00"}';
    expect(
      contentOf({
        body: JSON.stringify({ choices: [{ message: { content: answer, role: 'assistant' } }] }),
        status: 200,
      }),
    ).toBe(answer);
    expect(() => contentOf({ body: '{"error":"no key"}', status: 401 })).toThrow('answered 401');
    expect(() => contentOf({ body: JSON.stringify({ choices: [] }), status: 200 })).toThrow(
      'gave no answer',
    );
  });
});
