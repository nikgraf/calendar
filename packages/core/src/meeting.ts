/**
 * Finds the video-call link for an event: Google's own conference link
 * first, then well-known meeting URLs pasted into location or description.
 */

const MEETING_URL = new RegExp(
  'https://(?:' +
    [
      String.raw`meet\.google\.com/[a-z0-9-]+`,
      // The domain itself or a subdomain of it ("us02web.zoom.us") — a
      // bare prefix also let "securezoom.us" pass as Zoom.
      String.raw`(?:[\w-]+\.)*zoom\.us/(?:j|my|s)/[\w?=&.-]+`,
      // Classic join links, the short "/meet/<id>?p=<passcode>" ones, and
      // Teams free (teams.live.com).
      String.raw`teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/[\w%/?=&.-]+`,
      // Personal rooms and "/<site>/j.php?MTID=…" meeting links.
      String.raw`(?:[\w-]+\.)*webex\.com/(?:(?:meet|join)/[\w?=&.-]+|[\w-]+/j\.php\?[\w%=&.-]+)`,
      String.raw`whereby\.com/[\w-]+`,
    ].join('|') +
    ')',
  'i',
);

export const meetingUrl = (event: {
  readonly description?: string | undefined;
  readonly hangoutLink?: string | undefined;
  readonly location?: string | undefined;
}): string | undefined => {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  for (const text of [event.location, event.description]) {
    const match = text?.match(MEETING_URL);
    if (match) {
      return match[0];
    }
  }
  return undefined;
};
