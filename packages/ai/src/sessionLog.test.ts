import { describe, expect, it } from 'vite-plus/test';
import {
  appendSession,
  type AssistantSession,
  parseSessions,
  SESSION_LOG_CAP,
  SESSION_LOG_VERSION,
  sessionCount,
  sessionCountLabel,
  sessionExportName,
} from './sessionLog.ts';

const session = (id: string): AssistantSession => ({
  app: { platform: 'Mac', version: '0.1.0' },
  endedAt: '2026-11-26T08:00:05.000Z',
  id,
  left: 0,
  model: 'fixture',
  origin: 'new',
  picks: [],
  saved: [],
  startedAt: '2026-11-26T08:00:00.000Z',
  timeZone: 'Europe/Vienna',
  turns: [
    {
      at: '2026-11-26T08:00:00.000Z',
      day: '2026-11-26',
      input: 'typed',
      outcome: { kind: 'changed', summary: 'Lunch · Thu, Nov 26 · 13:00–14:00' },
      reads: [{ answer: { title: 'Lunch' }, prompt: 'Phrase: lunch at 1' }],
      route: 'first',
      text: 'lunch at 1',
    },
  ],
  v: SESSION_LOG_VERSION,
});

describe('appendSession', () => {
  it('adds a line per session, the newest last', () => {
    const text = appendSession(appendSession('', session('a')), session('b'));
    expect(text.endsWith('\n')).toBe(true);
    expect(parseSessions(text).sessions.map((each) => each.id)).toEqual(['a', 'b']);
    expect(sessionCount(text)).toBe(2);
  });

  it('drops the oldest past the cap', () => {
    let text = '';
    for (const id of ['a', 'b', 'c', 'd']) {
      text = appendSession(text, session(id), 3);
    }
    expect(parseSessions(text).sessions.map((each) => each.id)).toEqual(['b', 'c', 'd']);
  });

  it('keeps 200 by default', () => {
    let text = '';
    for (let at = 0; at < SESSION_LOG_CAP + 5; at += 1) {
      text = appendSession(text, session(`s${String(at)}`));
    }
    const { sessions } = parseSessions(text);
    expect(sessions).toHaveLength(SESSION_LOG_CAP);
    expect(sessions[0]?.id).toBe('s5');
  });

  it('keeps lines it cannot read as they are, until they age out', () => {
    const text = appendSession('not json\n{"v":0,"id":"old"}\n', session('a'));
    expect(text.split('\n')[0]).toBe('not json');
    expect(parseSessions(text)).toMatchObject({ sessions: [{ id: 'a' }], skipped: 2 });
  });
});

describe('labels', () => {
  it('names the export by its day and counts the sessions', () => {
    expect(sessionExportName('2026-11-26')).toBe('solunivo-assistant-sessions-2026-11-26.jsonl');
    expect([0, 1, 12].map(sessionCountLabel)).toEqual([
      'No sessions kept',
      '1 session kept',
      '12 sessions kept',
    ]);
  });
});
