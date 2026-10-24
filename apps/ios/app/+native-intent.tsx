import { extractSettingsCode } from '@calendar/core/settingsCode';

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
 * A URL that carries a settings code (the Camera app's "Open in
 * Solunivo", or the e2e link that stands in for a share) is read where the
 * person is: in a running app it moves nothing (null) — sending it to `/`
 * would close the setup whose copy step is waiting for it — and only a
 * cold start gets the calendar.
 */
export function redirectSystemPath({
  initial,
  path,
}: {
  initial: boolean;
  path: string;
}): string | null {
  if (extractSettingsCode(decoded(path))) {
    return initial ? '/' : null;
  }
  return path.startsWith('/') &&
    !/expo-sharing|capture-fixture|onboarding-fixture|oauth/i.test(path)
    ? path
    : '/';
}
