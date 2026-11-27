import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AssistantSession, SESSION_LOG_VERSION } from '@calendar/ai';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { sessionsFile } from './assistantSessionsFile.ts';

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
  timeZone: 'UTC',
  turns: [],
  v: SESSION_LOG_VERSION,
});

const dirs: Array<string> = [];
const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('sessionsFile', () => {
  it('is off, and keeps nothing, until switched on', () => {
    const file = sessionsFile(profile());
    expect(file.state()).toEqual({ count: 0, on: false });
    expect(file.keep(session('a'))).toEqual({ count: 0, on: false });
    expect(file.read()).toBe('');
  });

  it('keeps sessions as lines once on, and deletes them all', () => {
    const dir = profile();
    const file = sessionsFile(dir);
    file.setOn(true);
    file.keep(session('a'));
    expect(file.keep(session('b'))).toEqual({ count: 2, on: true });
    expect(readFileSync(join(dir, 'assistant-sessions.jsonl'), 'utf8').split('\n')).toHaveLength(3);
    expect(sessionsFile(dir).state()).toEqual({ count: 2, on: true });
    expect(file.delete()).toEqual({ count: 0, on: true });
  });

  it('keeps nothing more once switched off, and keeps what it has', () => {
    const file = sessionsFile(profile());
    file.setOn(true);
    file.keep(session('a'));
    file.setOn(false);
    expect(file.keep(session('b'))).toEqual({ count: 1, on: false });
  });
});
