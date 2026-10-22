import { existsSync } from 'node:fs';
import { Duration, Effect } from 'effect';

/**
 * CALENDAR_EVENTKIT_HOLD (the e2e harness's marker file): while it exists,
 * a write of the Reminders or Apple Calendar fixture waits, as on a slow
 * EventKit, so a spec can act while a save or delete is under way. Only
 * the fixture clients read it.
 */
const holdPath = process.env['CALENDAR_EVENTKIT_HOLD'];
/** How often a held write checks the marker file. */
const HOLD_POLL = Duration.millis(50);

const whileHeld = (path: string): Effect.Effect<void> =>
  Effect.suspend(() =>
    existsSync(path) ? Effect.sleep(HOLD_POLL).pipe(Effect.andThen(whileHeld(path))) : Effect.void,
  );

/** A fixture write, run once a spec lets go of the hold (at once when none is set). */
export const afterHold = <A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  holdPath ? whileHeld(holdPath).pipe(Effect.andThen(write)) : write;
