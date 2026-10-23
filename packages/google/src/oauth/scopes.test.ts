import { describe, expect, it } from 'vite-plus/test';
import {
  CONTACTS_SCOPES,
  GOOGLE_SCOPES,
  googleScopes,
  grantsCalendarCreation,
  grantsContacts,
  TASKS_SCOPE,
} from './scopes.ts';

describe('googleScopes', () => {
  it('asks for everything with tasks, and the same list minus the tasks scope without', () => {
    expect(googleScopes({ tasks: true })).toEqual(GOOGLE_SCOPES);
    const withoutTasks = googleScopes({ tasks: false });
    expect(withoutTasks).not.toContain(TASKS_SCOPE);
    expect(withoutTasks).toEqual(GOOGLE_SCOPES.filter((scope) => scope !== TASKS_SCOPE));
    // Calendar and contacts stay: only the tasks box moved.
    expect(withoutTasks).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(grantsContacts(withoutTasks)).toBe(true);
    expect(grantsCalendarCreation(withoutTasks)).toBe(true);
  });

  it('keeps the full list the fixtures and the live wire sign in with', () => {
    expect(GOOGLE_SCOPES).toContain(TASKS_SCOPE);
    for (const scope of CONTACTS_SCOPES) {
      expect(GOOGLE_SCOPES).toContain(scope);
    }
  });
});
