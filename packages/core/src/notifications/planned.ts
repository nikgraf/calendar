/** One local notification the platform sink delivers or schedules. */
export interface PlannedNotification {
  readonly body: string;
  /**
   * Epoch ms after which a missed notification is no longer worth showing:
   * an immediate sink catching up after sleep fires only while
   * `fireAt <= now < expiresAt`. Each producer sets its own rule — a
   * birthday stays useful all day, "meeting in 10 minutes" does not.
   */
  readonly expiresAt: number;
  /** Epoch ms of delivery. */
  readonly fireAt: number;
  /** Stable across runs and unique per producer, so a sink can dedupe. */
  readonly key: string;
  readonly title: string;
}
