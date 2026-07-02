// Single Temporal implementation for the whole app. rrule-temporal constructs its
// instances from @js-temporal/polyfill, so every platform must use this exact
// implementation for instance interop — never globalThis.Temporal, even where it
// exists natively (Electron renderer).
import './intl-compat.ts';

export { Intl, Temporal, toTemporalInstant } from '@js-temporal/polyfill';
