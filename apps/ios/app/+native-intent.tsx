import { extractSettingsCode } from '@calendar/core/settingsCode';
import { awaitingCode } from '../src/settingsCodeInbox.ts';

const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * The URLs that open the app are not routes: the share extension's
 * `<scheme>://expo-sharing`, the e2e flows' `capture-fixture` and
 * `onboarding-fixture` deep links and Google's OAuth redirect (the
 * reversed client id scheme). The calendar
 * screen's `Linking` listener still receives each raw URL and acts on it;
 * the router itself just stays on the calendar instead of showing an
 * unmatched-route screen.
 *
 * A settings code that is the URL (the Camera app's "Open in Solunivo":
 * `SOLUNIVO:1:…` parses as a `solunivo:` URL) is read where the person
 * is: in a running app it moves nothing (null) — sending it to `/` would
 * close the setup whose copy step is waiting for it — and only a cold
 * start gets the calendar. A share's own URL carries no text (the
 * extension stores it), so while the setup is up or a code reader is in
 * front a warm share moves nothing either: it may well be the Mac's code,
 * shared in for that reader. Elsewhere a share goes to the calendar, and
 * EditorHost hands a code in it over only after that navigation. The e2e
 * `capture-fixture` link stands in for a share and takes the same path,
 * code or not.
 */
export function redirectSystemPath({
  initial,
  path,
}: {
  initial: boolean;
  path: string;
}): string | null {
  if (/^solunivo:/i.test(path) && extractSettingsCode(decoded(path))) {
    return initial ? '/' : null;
  }
  if (!initial && awaitingCode() && /expo-sharing|capture-fixture/i.test(path)) {
    return null;
  }
  return path.startsWith('/') &&
    !/expo-sharing|capture-fixture|onboarding-fixture|oauth/i.test(path)
    ? path
    : '/';
}
