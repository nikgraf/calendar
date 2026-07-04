import { describe, expect, it } from 'vitest';
import { meetingUrl } from './meeting.ts';

describe('meetingUrl', () => {
  it('prefers the hangoutLink', () => {
    expect(
      meetingUrl({
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        location: 'https://zoom.us/j/123',
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('finds zoom links in the location', () => {
    expect(meetingUrl({ location: 'Zoom: https://us02web.zoom.us/j/8881234567?pwd=abc' })).toBe(
      'https://us02web.zoom.us/j/8881234567?pwd=abc',
    );
  });

  it('finds meet and teams links in the description', () => {
    expect(meetingUrl({ description: 'join at https://meet.google.com/abc-defg-hij ok' })).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(
      meetingUrl({
        description: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x?context=y',
      }),
    ).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x?context=y');
  });

  it('returns undefined for plain rooms and non-meeting urls', () => {
    expect(meetingUrl({ location: 'Room 4.01' })).toBeUndefined();
    expect(meetingUrl({ description: 'agenda: https://example.com/doc' })).toBeUndefined();
    expect(meetingUrl({})).toBeUndefined();
  });
});
