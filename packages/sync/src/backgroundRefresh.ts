import { type Duration, Effect, Option } from 'effect';
import { SyncEngine } from './engine.ts';
import { LocalNotifications } from './localNotifications.ts';
import { Mirrors } from './mirrors.ts';

/**
 * One opportunistic background pass (iOS background task): pull what
 * changed elsewhere, then hand the OS a fresh notification schedule.
 *
 * The sync is bounded by `syncBudget` — the OS may end the task at any
 * time, and a slow or failing pull (no network, a Keychain item not yet
 * readable) must not cost the schedule refresh, which works from local
 * data alone. An unfinished sync is interrupted; the foreground run picks
 * it up again. The calendar mirrors go last, within `mirrorBudget`: they
 * only write what a fresh pull changed, and a cut-off mirror pass just
 * plans again next time. Never fails.
 */
export const backgroundRefresh = (
  syncBudget: Duration.Input,
  mirrorBudget: Duration.Input,
): Effect.Effect<void, never, LocalNotifications | Mirrors | SyncEngine> =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    const notifications = yield* LocalNotifications;
    // syncAll logs its own failures, but a defect (a Keychain read that
    // throws while the phone is locked) must not skip the schedule either.
    const synced = yield* Effect.timeoutOption(engine.syncAll(), syncBudget).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning('background refresh: sync failed', { cause: String(cause) }),
          Option.some(undefined),
        ),
      ),
    );
    if (Option.isNone(synced)) {
      yield* Effect.logWarning('background refresh: sync exceeded its budget');
    }
    yield* notifications.run();
    yield* (yield* Mirrors).run({ budget: mirrorBudget });
  });
