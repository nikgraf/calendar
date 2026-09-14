// Single Temporal implementation for the whole app. rrule-temporal 2.x builds
// its occurrences from whichever Temporal it is handed (`temporal:` option;
// its own default would be native Temporal or a second bundled polyfill), so
// every RRuleTemporal here passes this namespace and every platform uses this
// exact implementation for instance interop — never globalThis.Temporal, even
// where it exists natively (Electron renderer).
import './intl-compat.ts';

export { Intl, Temporal, toTemporalInstant } from '@js-temporal/polyfill';
