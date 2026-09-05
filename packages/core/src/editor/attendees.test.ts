import { describe, expect, it } from 'vitest';
import { Attendee } from '../types.ts';
import { mergeAttendees } from './attendees.ts';

const organizer = new Attendee({
  email: 'Org@Example.com',
  isOrganizer: true,
  isSelf: true,
  responseStatus: 'accepted',
});
const guest = new Attendee({
  displayName: 'Alice',
  email: 'alice@example.com',
  responseStatus: 'tentative',
});

describe('mergeAttendees', () => {
  it('keeps server facts for retained emails and adds newcomers as needsAction', () => {
    const merged = mergeAttendees(
      [organizer, guest],
      [{ email: 'org@example.com' }, { displayName: 'Bob', email: 'bob@example.com' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      email: 'Org@Example.com',
      isOrganizer: true,
      responseStatus: 'accepted',
    });
    expect(merged[1]).toMatchObject({
      displayName: 'Bob',
      email: 'bob@example.com',
      responseStatus: 'needsAction',
    });
  });

  it('drops attendees missing from the input', () => {
    expect(mergeAttendees([organizer, guest], [{ email: 'org@example.com' }])).toHaveLength(1);
    expect(mergeAttendees([organizer, guest], [])).toHaveLength(0);
  });

  it('collapses duplicates and blank emails, trimming the rest', () => {
    const merged = mergeAttendees(undefined, [
      { email: ' bob@example.com ' },
      { email: 'BOB@example.com' },
      { email: '  ' },
    ]);
    expect(merged.map((attendee) => attendee.email)).toEqual(['bob@example.com']);
  });

  it('lets the editor supply a display name for an existing guest without one', () => {
    const nameless = new Attendee({ email: 'c@example.com', responseStatus: 'declined' });
    const merged = mergeAttendees([nameless], [{ displayName: 'Carol', email: 'c@example.com' }]);
    expect(merged[0]).toMatchObject({ displayName: 'Carol', responseStatus: 'declined' });
  });
});
