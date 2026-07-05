/**
 * Finds the video-call link for an event: Google's own conference link
 * first, then well-known meeting URLs pasted into location or description.
 */

const MEETING_URL = new RegExp(
  'https://(?:' +
    [
      String.raw`meet\.google\.com/[a-z0-9-]+`,
      String.raw`[\w.-]*zoom\.us/(?:j|my|s)/[\w?=&.-]+`,
      String.raw`teams\.microsoft\.com/l/meetup-join/[\w%/?=&.-]+`,
      String.raw`[\w.-]*webex\.com/(?:meet|join)/[\w?=&.-]+`,
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
