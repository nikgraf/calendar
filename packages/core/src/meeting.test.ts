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

  it('finds the newer Teams and Webex link shapes', () => {
    for (const link of [
      'https://teams.microsoft.com/meet/2345678901234?p=AbCdEfGh',
      'https://teams.live.com/meet/9876543210987?p=xYz123',
      'https://teams.live.com/l/meetup-join/19%3ameeting_x?context=y',
      'https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef0123456789abcdef',
    ]) {
      expect(meetingUrl({ description: `Join: ${link} (by phone below)` }), link).toBe(link);
    }
    for (const location of [
      'https://teams.microsoft.com.evil.example/meet/1',
      'https://evilteams.live.com/meet/1',
      'https://acme.webex.com.evil.example/acme/j.php?MTID=m1',
    ]) {
      expect(meetingUrl({ location }), location).toBeUndefined();
    }
  });

  it('takes a Zoom or Webex link only from the real domain or a subdomain of it', () => {
    expect(meetingUrl({ location: 'https://acme.webex.com/meet/ana' })).toBe(
      'https://acme.webex.com/meet/ana',
    );
    // Look-alikes got a green "Join meeting" button pointing elsewhere.
    for (const location of [
      'https://securezoom.us/j/1',
      'https://evilwebex.com/meet/ana',
      'https://zoom.us.evil.example/j/1',
    ]) {
      expect(meetingUrl({ location }), location).toBeUndefined();
    }
  });

  it('returns undefined for plain rooms and non-meeting urls', () => {
    expect(meetingUrl({ location: 'Room 4.01' })).toBeUndefined();
    expect(meetingUrl({ description: 'agenda: https://example.com/doc' })).toBeUndefined();
    expect(meetingUrl({})).toBeUndefined();
  });
});
