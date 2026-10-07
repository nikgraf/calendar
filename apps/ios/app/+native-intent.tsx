/**
 * The URLs that open the app are not routes: the share extension's
 * `<scheme>://expo-sharing`, the e2e flows' `capture-fixture` deep link and
 * Google's OAuth redirect (the reversed client id scheme). The calendar
 * screen's `Linking` listener still receives each raw URL and acts on it;
 * the router itself just stays on the calendar instead of showing an
 * unmatched-route screen.
 */
export function redirectSystemPath({ path }: { initial: boolean; path: string }): string {
  return path.startsWith('/') && !/expo-sharing|capture-fixture|oauth/i.test(path) ? path : '/';
}
