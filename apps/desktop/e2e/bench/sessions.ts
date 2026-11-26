import type { AssistantSession, SessionSaved, SessionTurn } from '@calendar/ai';

/**
 * An export of Keep Assistant Sessions (`sessionLog.ts` in `@calendar/ai`)
 * read on the Mac: where the threads were lost, and a thread as a draft
 * bench case. `sessionsReport.ts` is the command. An export holds the
 * names and places a person said: a draft case is written outside the
 * repo, and a person replaces them before it is committed (README → "A
 * phrase from real use").
 */

/** How a thread ended, as the summary counts it. */
export type ThreadEnd = 'abandoned' | 'edited' | 'untouched';

/** Saved as the Assistant left it, saved after edits by hand, or never saved. */
export const threadEnd = (session: AssistantSession): ThreadEnd =>
  session.saved.length === 0
    ? 'abandoned'
    : session.saved.some((item) => item.edited.length > 0)
      ? 'edited'
      : 'untouched';

/** A thread's turns were all typed, all dictated, or both. */
export const threadInput = (session: AssistantSession): 'dictated' | 'mixed' | 'typed' => {
  const inputs = new Set(session.turns.map((turn) => turn.input));
  return inputs.size > 1 ? 'mixed' : inputs.has('dictated') ? 'dictated' : 'typed';
};

export interface SessionsSummary {
  /** Threads by how they ended, by how they were said. */
  readonly ends: Readonly<
    Record<'dictated' | 'mixed' | 'typed', Readonly<Record<ThreadEnd, number>>>
  >;
  /** The parts changed by hand on the items saved, most often first. */
  readonly fields: ReadonlyArray<readonly [string, number]>;
  /** Turns by what became of them, by how they were said. */
  readonly outcomes: Readonly<Record<'dictated' | 'typed', Readonly<Record<string, number>>>>;
  readonly parakeet: number;
  readonly threads: number;
  readonly turns: number;
}

const zero = (): Record<ThreadEnd, number> => ({ abandoned: 0, edited: 0, untouched: 0 });

export const summarize = (sessions: ReadonlyArray<AssistantSession>): SessionsSummary => {
  const ends = { dictated: zero(), mixed: zero(), typed: zero() };
  const outcomes: Record<'dictated' | 'typed', Record<string, number>> = {
    dictated: {},
    typed: {},
  };
  const fields = new Map<string, number>();
  let turns = 0;
  let parakeet = 0;
  for (const session of sessions) {
    ends[threadInput(session)][threadEnd(session)] += 1;
    for (const item of session.saved) {
      for (const field of item.edited) {
        fields.set(field, (fields.get(field) ?? 0) + 1);
      }
    }
    for (const turn of session.turns) {
      turns += 1;
      parakeet += turn.parakeet === true ? 1 : 0;
      const kind = turn.undone === true ? 'undone' : turn.outcome.kind;
      const counts = outcomes[turn.input];
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return {
    ends,
    fields: [...fields].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    outcomes,
    parakeet,
    threads: sessions.length,
    turns,
  };
};

const counted = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${String(count)}`)
    .join(', ') || 'none';

/** The summary as the command prints it. */
export const formatSummary = (summary: SessionsSummary, skipped = 0): string =>
  [
    `${String(summary.threads)} threads, ${String(summary.turns)} turns (${String(summary.parakeet)} read with Parakeet)${skipped > 0 ? `, ${String(skipped)} lines unread` : ''}`,
    '',
    'Threads (saved untouched / saved after hand edits / abandoned):',
    ...(['dictated', 'typed', 'mixed'] as const).map((input) => {
      const ends = summary.ends[input];
      return `  ${input.padEnd(9)} ${String(ends.untouched)} / ${String(ends.edited)} / ${String(ends.abandoned)}`;
    }),
    '',
    `Changed by hand before saving: ${summary.fields.map(([field, count]) => `${field} ${String(count)}`).join(', ') || 'nothing'}`,
    '',
    'Turns:',
    `  dictated  ${counted(summary.outcomes.dictated)}`,
    `  typed     ${counted(summary.outcomes.typed)}`,
  ].join('\n');

/** One thread a line: its id, how it ended, its first words. */
export const listSessions = (sessions: ReadonlyArray<AssistantSession>): string =>
  sessions
    .map(
      (session) =>
        `${session.id}  ${threadEnd(session).padEnd(9)} ${threadInput(session).padEnd(8)} ${String(session.turns.length)} turns  “${session.turns[0]?.text ?? ''}”${
          session.saved.some((item) => item.edited.length > 0)
            ? `  (by hand: ${[...new Set(session.saved.flatMap((item) => item.edited))].join(', ')})`
            : ''
        }`,
    )
    .join('\n');

const daysBetween = (from: string, to: string): number => {
  const day = (iso: string) =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((day(to) - day(from)) / 86_400_000);
};

/** Where the saved item is, as a bench expectation: a day from the turn's, never a literal date. */
const expectationOf = (item: SessionSaved, day: string): Record<string, unknown> => ({
  ...(item.date === undefined ? {} : { dayOffset: daysBetween(day, item.date) }),
  ...(item.endTime === undefined || item.kind === 'task' ? {} : { endTime: item.endTime }),
  ...(item.isAllDay === true ? { isAllDay: true } : {}),
  ...(item.kind === 'task' ? { kind: 'task' } : {}),
  location: item.location ?? null,
  ...(item.startTime === undefined ? {} : { startTime: item.startTime }),
  title: item.title,
});

/** The turns a case replays: said and taken, never taken back. */
const replayed = (session: AssistantSession): ReadonlyArray<SessionTurn> =>
  session.turns.filter(
    (turn) =>
      turn.undone !== true &&
      (turn.outcome.kind === 'changed' || turn.outcome.kind === 'no-change'),
  );

/**
 * A thread as a draft bench case (`cases.ts`): its turns as they were
 * heard, the last held to where the first item saved stands (the day
 * from the turn's own), the earlier ones to nothing yet. A person
 * writes what each earlier turn should leave, replaces every real name
 * and place, and checks the guests, repeat and notifications, which an
 * export does not say in full. Undefined for a thread with no turn to
 * replay.
 */
export const draftCase = (
  session: AssistantSession,
  { lang = 'en' }: { readonly lang?: 'de' | 'en' } = {},
): Record<string, unknown> | undefined => {
  const turns = replayed(session);
  const last = turns.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const [saved] = session.saved;
  const input = new Set(turns.map((turn) => turn.input));
  return {
    lang,
    tags: ['phone', ...[...input].toSorted(), ...(turns.length > 1 ? ['flow'] : [])],
    turns: turns.map((turn) => ({
      expect: turn === last && saved !== undefined ? expectationOf(saved, turn.day) : {},
      input: { text: turn.text },
    })),
  };
};
