import { always, type Tree } from '@antithesishq/bombadil';
import {
  type ActionTemplate,
  actions,
  extract,
  registerCustomAction,
} from '@antithesishq/bombadil/browser';
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

/**
 * Bombadil actions for the recurring-event editor: open an occurrence of
 * a seeded daily series, pick a scope (This event / This and following /
 * All events), edit title, times and (one occurrence only) the date, then
 * cancel or Save in a burst. The page keeps a ledger of every save; the
 * spec (`bombadilRecurring.e2e.ts`) replays it through its own model and
 * compares what SQLite draws, all of the series' range included.
 *
 * Generation stays where the documented semantics are unambiguous: a
 * series or following edit never changes the date, a moved occurrence is
 * edited on its own only, and a time change for every event waits until
 * the series has no edited occurrences (a stored exception keeps its own
 * times through a series edit, docs/architecture.md → Recurring events).
 */

type Scope = 'instance' | 'following' | 'series';

interface Form {
  readonly date: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly startTime: string;
  readonly title: string;
}

interface Opened {
  /** Edited on its own before (a stored exception, not a drawn occurrence). */
  readonly exception: boolean;
  readonly form: Form;
  readonly masterId: string;
  /** Shown on another day than its slot: edited on its own only. */
  readonly moved: boolean;
  /** The occurrence's slot in its series (`originalStartUtc`). */
  readonly slotUtc: number;
  readonly testId: string;
}

interface Session {
  form: Form;
  readonly opened: Opened;
  scope: Scope;
}

interface Saved {
  readonly clicks: number;
  /** The series a this-and-following split started, read from the grid. */
  readonly createdMasterId: string | null;
  readonly form: Form;
  readonly opened: Opened;
  readonly scope: Scope;
}

interface Probe {
  cancelled: number;
  /** Slots edited on their own, per series, while they still show. */
  exceptions: Record<string, Array<number>>;
  failure: string | null;
  /** Each series' first day: "following" there is the whole series. */
  firstDays: Record<string, string>;
  opened: number;
  prefix: number;
  saved: Array<Saved>;
  session: Session | null;
}

interface Seed {
  readonly firstDay: string;
  readonly masterId: string;
}

/** Start/end pairs a time change picks from; the seed runs 09:00–09:30. */
const TIMES: ReadonlyArray<readonly [string, string]> = [
  ['08:00', '08:30'],
  ['10:00', '11:00'],
  ['13:00', '13:30'],
];
/** Days a one-occurrence date change moves by; a month only while the week has plenty left. */
const DAY_OFFSETS: ReadonlyArray<number> = [-1, 1];
const FAR_OFFSET = 30;
const PREFIX_STEPS = 5;
const SCOPE_LABEL: Record<Scope, string> = {
  following: 'This and following',
  instance: 'This event',
  series: 'All events',
};

const seedOf = (document: Document): Seed =>
  JSON.parse(document.body.dataset['bombadilRecurringSeed']!) as Seed;

const read = (document: Document): Probe => {
  const stored = document.body.dataset['bombadilRecurringProbe'];
  if (stored) {
    return JSON.parse(stored) as Probe;
  }
  const seed = seedOf(document);
  return {
    cancelled: 0,
    exceptions: { [seed.masterId]: [] },
    failure: null,
    firstDays: { [seed.masterId]: seed.firstDay },
    opened: 0,
    prefix: 0,
    saved: [],
    session: null,
  };
};

const write = (document: Document, probe: Probe): void => {
  document.body.dataset['bombadilRecurringProbe'] = JSON.stringify(probe);
};

const waitFor = async (holds: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() >= deadline) {
      throw new Error(`Within 10 seconds: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const isoDay = (utc: number): string => new Date(utc).toISOString().slice(0, 10);

const addDays = (day: string, days: number): string =>
  isoDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);

/** `20261103T090000Z` → epoch ms, as Google's instance ids carry the slot. */
const compactMs = (compact: string): number =>
  Date.parse(
    `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`,
  );

/**
 * A block's place in its series, from its id: a drawn occurrence is
 * `<master>__<slot ms>`, a stored exception `<master>_<YYYYMMDDTHHMMSSZ>`
 * (Google's instance id). Event ids here carry no underscore otherwise.
 */
const slotOf = (
  testId: string,
): { readonly exception: boolean; readonly masterId: string; readonly slotUtc: number } | null => {
  const id = testId.slice('timed-event-'.length);
  const drawn = /^([^_]+)__(\d+)$/.exec(id);
  if (drawn) {
    return { exception: false, masterId: drawn[1]!, slotUtc: Number(drawn[2]) };
  }
  const stored = /^([^_]+)_(\d{8}T\d{6}Z)$/.exec(id);
  return stored ? { exception: true, masterId: stored[1]!, slotUtc: compactMs(stored[2]!) } : null;
};

/** Whether the element's centre is inside every clipping ancestor: the grid draws hidden pan-buffer days. */
const onScreen = (element: Element): boolean => {
  const view = element.ownerDocument.defaultView!;
  const rect = element.getBoundingClientRect();
  const x = (rect.left + rect.right) / 2;
  if (rect.width === 0 || x < 0 || x > view.innerWidth) {
    return false;
  }
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (view.getComputedStyle(parent).overflowX !== 'visible') {
      const box = parent.getBoundingClientRect();
      if (x < box.left || x > box.right) {
        return false;
      }
    }
  }
  return true;
};

/** The week grid's days on screen, in order (the all-day lane repeats them). */
const visibleDays = (document: Document): Array<string> =>
  [
    ...new Set(
      [...document.querySelectorAll<HTMLElement>('[data-day]')]
        .filter(onScreen)
        .map((column) => column.dataset['day']!),
    ),
  ].sort();

interface Block {
  readonly day: string;
  readonly label: string;
  readonly testId: string;
}

/** The series' occurrences in the visible week, in day and time order. */
const visibleBlocks = (document: Document): Array<Block> => {
  const days = new Set(visibleDays(document));
  return [...document.querySelectorAll<HTMLElement>('[data-day] [data-testid^="timed-event-"]')]
    .map((block) => ({
      day: block.closest<HTMLElement>('[data-day]')!.dataset['day']!,
      label: block.getAttribute('aria-label') ?? '',
      testId: block.dataset['testid']!,
    }))
    .filter((block) => days.has(block.day) && slotOf(block.testId) !== null)
    .sort((a, b) => a.day.localeCompare(b.day) || a.label.localeCompare(b.label));
};

const field = (document: Document, label: string): HTMLInputElement => {
  const selector =
    label === 'Title' ? 'input[placeholder="Title"]' : `input[aria-label="${label}"]`;
  const input = document.querySelector<HTMLInputElement>(`[data-testid="editor"] ${selector}`);
  if (!input) {
    throw new Error(`Editor field missing: ${label}`);
  }
  return input;
};

const form = (document: Document): Form => ({
  date: field(document, 'Date').value,
  endDate: field(document, 'End date').value,
  endTime: field(document, 'End time').value,
  startTime: field(document, 'Start time').value,
  title: field(document, 'Title').value,
});

const setField = async (document: Document, label: string, value: string): Promise<void> => {
  const input = field(document, label);
  input.scrollIntoView({ block: 'center' });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => field(document, label).value === value, `the ${label} field reads ${value}`);
  // React may still be committing the controlled field's change to its model.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const button = (document: Document, label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="editor"] button'),
  ].find((candidate) => candidate.textContent.trim() === label);
  if (!found) {
    throw new Error(`Editor button missing: ${label}`);
  }
  found.scrollIntoView({ block: 'center' });
  return found;
};

/** The editor's own "Apply to" control; the inspector has one too, for deletes. */
const shownScope = (document: Document): string | null =>
  document
    .querySelector(
      '[data-testid="editor"] [role="radiogroup"][aria-label="Apply to"] [aria-checked="true"]',
    )
    ?.textContent.trim() ?? null;

const showForm = async (document: Document): Promise<void> => {
  await waitFor(
    () => document.querySelector('[data-testid="editor"]') !== null,
    'the editor opens',
  );
  document.querySelector<HTMLButtonElement>('[data-testid="editor-view-form"]')?.click();
  await waitFor(() => {
    const pane = document.querySelector('[data-testid="editor-form"]');
    return pane !== null && !pane.hasAttribute('inert') && pane.getBoundingClientRect().height > 0;
  }, 'the editor shows its form');
};

const closeEditor = async (document: Document): Promise<void> => {
  button(document, 'Cancel').click();
  await waitFor(
    () =>
      document.querySelector('[data-testid="editor"]') === null ||
      document.querySelector('[data-testid="discard-confirm-yes"]') !== null,
    'Cancel closes the editor or asks first',
  );
  document.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-yes"]')?.click();
  await waitFor(
    () => document.querySelector('[data-testid="editor"]') === null,
    'the editor closes after Cancel',
  );
};

const openBlock = async (document: Document, testId: string): Promise<void> => {
  const block = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!block) {
    throw new Error(`Occurrence missing: ${testId}`);
  }
  block.scrollIntoView({ block: 'center', inline: 'nearest' });
  block.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await waitFor(
    () => document.querySelector('[data-testid="inspector-edit"]') !== null,
    'the inspector offers Edit',
  );
  document.querySelector<HTMLButtonElement>('[data-testid="inspector-edit"]')!.click();
  await showForm(document);
  if (shownScope(document) !== SCOPE_LABEL.instance) {
    throw new Error(`An occurrence opened with "${String(shownScope(document))}" chosen`);
  }
};

const sameForm = (a: Form, b: Form): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Opens a block, gives the session its own title and records what it opened with. */
const begin = async (document: Document, testId: string): Promise<void> => {
  const slot = slotOf(testId);
  if (!slot) {
    throw new Error(`Not an occurrence of the series: ${testId}`);
  }
  await openBlock(document, testId);
  const opened: Opened = {
    ...slot,
    form: form(document),
    moved: slot.exception && form(document).date !== isoDay(slot.slotUtc),
    testId,
  };
  if (!slot.exception && opened.form.date !== isoDay(slot.slotUtc)) {
    throw new Error(`A drawn occurrence opened on another day than its slot: ${testId}`);
  }
  const probe = read(document);
  probe.opened += 1;
  const title = `Bombadil series ${probe.opened}`;
  await setField(document, 'Title', title);
  probe.session = { form: { ...opened.form, title }, opened, scope: 'instance' };
  write(document, probe);
};

const chooseScope = async (document: Document, scope: Scope): Promise<void> => {
  button(document, SCOPE_LABEL[scope]).click();
  await waitFor(
    () => shownScope(document) === SCOPE_LABEL[scope],
    `"${SCOPE_LABEL[scope]}" is chosen`,
  );
  const probe = read(document);
  probe.session!.scope = scope;
  write(document, probe);
};

const changeTimes = async (document: Document, choice: number): Promise<void> => {
  const [start, end] = TIMES[choice]!;
  await setField(document, 'Start time', start);
  await setField(document, 'End time', end);
  const probe = read(document);
  probe.session!.form = form(document);
  write(document, probe);
};

const moveDate = async (document: Document, offset: number): Promise<void> => {
  const probe = read(document);
  const date = addDays(probe.session!.opened.form.date, offset);
  await setField(document, 'Date', date);
  await setField(document, 'End date', date);
  probe.session!.form = form(document);
  write(document, probe);
};

/** "This and following" at a series' first occurrence edits the whole series. */
const effectiveScope = (probe: Probe, session: Session): Scope =>
  session.scope === 'following' &&
  isoDay(session.opened.slotUtc) === probe.firstDays[session.opened.masterId]
    ? 'series'
    : session.scope;

/** `HH:MM` of an instant, UTC: the slot's own time in the series. */
const clockOf = (utc: number): string => new Date(utc).toISOString().slice(11, 16);

/**
 * Why the session may not be saved yet, or null: generation stays on
 * documented ground. A series takes the form's times whenever they are
 * sent — on a time change, and always for "This and following", even at
 * the first occurrence, where it edits the whole series — measured from
 * the slot, not from what an occurrence edited on its own shows.
 */
const saveBlocked = (probe: Probe, session: Session): string | null => {
  const { opened } = session;
  const scope = effectiveScope(probe, session);
  if (scope === 'instance') {
    return null;
  }
  if (opened.moved) {
    return 'a moved occurrence is edited on its own';
  }
  if (session.form.date !== opened.form.date || session.form.endDate !== opened.form.endDate) {
    return 'only one occurrence changes its date';
  }
  const timesSent =
    session.scope === 'following' ||
    session.form.startTime !== opened.form.startTime ||
    session.form.endTime !== opened.form.endTime;
  if (
    scope === 'series' &&
    timesSent &&
    session.form.startTime !== clockOf(opened.slotUtc) &&
    (probe.exceptions[opened.masterId] ?? []).length > 0
  ) {
    // A new start drops the series' exceptions, as Google does
    // (docs/google-sync-and-testing.md, verified live 2026-11-22). The
    // spec's model does not replay that drop yet, so it stays out.
    return 'a series with edited occurrences keeps its times';
  }
  return null;
};

/** Waits until the grid's blocks stop changing (a save repaints in a burst). */
const settle = async (document: Document): Promise<void> => {
  const snapshot = () => JSON.stringify(visibleBlocks(document));
  const until = Date.now() + 3000;
  let last = snapshot();
  let stableSince = Date.now();
  while (Date.now() < until && Date.now() - stableSince < 300) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = snapshot();
    if (next !== last) {
      last = next;
      stableSince = Date.now();
    }
  }
};

const saveBurst = async (document: Document, clicks: number): Promise<void> => {
  const probe = read(document);
  const session = probe.session!;
  const blocked = saveBlocked(probe, session);
  if (blocked) {
    throw new Error(`Save offered where ${blocked}`);
  }
  if (
    !sameForm(form(document), session.form) ||
    shownScope(document) !== SCOPE_LABEL[session.scope]
  ) {
    throw new Error('The editor no longer shows the session’s values before Save');
  }
  const save = button(document, 'Save');
  await waitFor(() => !save.disabled, 'Save is enabled');
  // No waits between clicks: repeated activation while the write is
  // pending, including before React can disable the button.
  for (let press = 0; press < clicks; press += 1) {
    save.click();
  }
  await waitFor(
    () => document.querySelector('[data-testid="editor"]') === null,
    `Save (${SCOPE_LABEL[session.scope]}) closes the editor`,
  ).catch((error: unknown) => {
    // What the editor says instead: its error line, and the scope it shows now.
    const shown = [
      ...document.querySelectorAll('[data-testid="editor-form"] fieldset > p:not([data-testid])'),
    ].map((line) => line.textContent.trim());
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; opened ${session.opened.testId}, it says ${JSON.stringify(shown)} and shows "${String(shownScope(document))}"`,
    );
  });
  const { opened } = session;
  const scope = effectiveScope(probe, session);
  let createdMasterId: string | null = null;
  if (scope === 'instance') {
    const slots = probe.exceptions[opened.masterId] ?? [];
    if (!slots.includes(opened.slotUtc)) {
      probe.exceptions[opened.masterId] = [...slots, opened.slotUtc];
    }
  } else if (scope === 'following') {
    // The new series draws its first occurrence on the cut's day, at the
    // times the form sent; its id is the grid's only way to name it.
    const day = opened.form.date;
    const prefix = `${session.form.title}, `;
    await waitFor(
      () =>
        visibleBlocks(document).some((block) => {
          const slot = slotOf(block.testId);
          return (
            block.day === day &&
            block.label.startsWith(prefix) &&
            slot !== null &&
            !slot.exception &&
            slot.masterId !== opened.masterId
          );
        }),
      'the split draws its new series on the cut’s day',
    );
    const block = visibleBlocks(document).find(
      (candidate) => candidate.day === day && candidate.label.startsWith(prefix),
    )!;
    createdMasterId = slotOf(block.testId)!.masterId;
    probe.exceptions[opened.masterId] = (probe.exceptions[opened.masterId] ?? []).filter(
      (slot) => slot < opened.slotUtc,
    );
    probe.exceptions[createdMasterId] = [];
    probe.firstDays[createdMasterId] = day;
  }
  probe.saved.push({ clicks, createdMasterId, form: session.form, opened, scope: session.scope });
  probe.session = null;
  write(document, probe);
  await settle(document);
};

const checked = async (document: Document, run: () => Promise<void>): Promise<void> => {
  document.body.dataset['bombadilRecurringBusy'] = 'true';
  try {
    await run();
  } catch (error) {
    const probe = read(document);
    probe.failure = error instanceof Error ? error.message : String(error);
    write(document, probe);
  } finally {
    document.body.dataset['bombadilRecurringBusy'] = 'false';
  }
};

const blockOnDay = (document: Document, dayIndex: number): string => {
  const day = visibleDays(document)[dayIndex];
  const block = visibleBlocks(document).find((candidate) => candidate.day === day);
  if (!block) {
    throw new Error(`No occurrence on visible day ${String(dayIndex)} (${String(day)})`);
  }
  return block.testId;
};

/**
 * The fixed opening, so a short or unlucky run still covers each scope and
 * a cancellation: a cancelled edit of every kind, one occurrence retimed
 * on its own, a split later in the week with new times, a rename of the
 * whole original series (whose edited occurrence takes the new title, as
 * Google copies it), and a retime of the whole new series.
 */
const prefixStep = registerCustomAction(
  'recurring-prefix-step',
  async (document, _window, step: number) => {
    await checked(document, async () => {
      if (step === 0) {
        const testId = blockOnDay(document, 2);
        await openBlock(document, testId);
        const original = form(document);
        await setField(document, 'Title', 'This series edit must never be saved');
        await setField(document, 'Start time', TIMES[2]![0]);
        await setField(document, 'End time', TIMES[2]![1]);
        button(document, SCOPE_LABEL.following).click();
        await waitFor(
          () => shownScope(document) === SCOPE_LABEL.following,
          '"This and following" is chosen',
        );
        await closeEditor(document);
        await openBlock(document, testId);
        if (!sameForm(form(document), original)) {
          throw new Error('Cancelling an occurrence edit retained changes when reopened');
        }
        await closeEditor(document);
        const probe = read(document);
        probe.cancelled += 1;
        probe.prefix = 1;
        write(document, probe);
        return;
      }
      const plan: Record<number, { day: number; scope: Scope; times: number | null }> = {
        1: { day: 1, scope: 'instance', times: 1 },
        2: { day: 4, scope: 'following', times: 1 },
        3: { day: 0, scope: 'series', times: null },
        4: { day: 5, scope: 'series', times: 2 },
      };
      const { day, scope, times } = plan[step]!;
      await begin(document, blockOnDay(document, day));
      await chooseScope(document, scope);
      if (times !== null) {
        await changeTimes(document, times);
      }
      await saveBurst(document, 5);
      const probe = read(document);
      probe.prefix = step + 1;
      write(document, probe);
    });
  },
);

const openOccurrence = registerCustomAction(
  'open-recurring-occurrence',
  async (document, _window, index: number, scope: Scope) => {
    await checked(document, async () => {
      // Re-read at action time: a save may have repainted since generation.
      const blocks = visibleBlocks(document);
      if (blocks.length === 0) {
        throw new Error('The visible week shows no occurrence of the series');
      }
      await begin(document, blocks[index % blocks.length]!.testId);
      if (scope !== 'instance') {
        await chooseScope(document, scope);
      }
    });
  },
);

const pickScope = registerCustomAction(
  'choose-recurring-scope',
  async (document, _window, scope: Scope) => {
    await checked(document, () => chooseScope(document, scope));
  },
);

const retime = registerCustomAction(
  'change-recurring-times',
  async (document, _window, choice: number) => {
    await checked(document, () => changeTimes(document, choice));
  },
);

const redate = registerCustomAction(
  'move-recurring-date',
  async (document, _window, offset: number) => {
    await checked(document, () => moveDate(document, offset));
  },
);

const save = registerCustomAction(
  'save-recurring-repeatedly',
  async (document, _window, clicks: number) => {
    await checked(document, () => saveBurst(document, clicks));
  },
);

const cancelAndReopen = registerCustomAction('cancel-recurring-and-reopen', async (document) => {
  await checked(document, async () => {
    const probe = read(document);
    const { opened } = probe.session!;
    await closeEditor(document);
    await openBlock(document, opened.testId);
    if (!sameForm(form(document), opened.form)) {
      throw new Error(`Cancelling a ${probe.session!.scope} edit retained changes when reopened`);
    }
    await closeEditor(document);
    probe.cancelled += 1;
    probe.session = null;
    write(document, probe);
  });
});

const current = extract(({ document }) => {
  if (!document.body.dataset['bombadilRecurringSeed']) {
    return { blocked: true, blocks: 0, failure: null, open: false, prefix: 0, scope: null };
  }
  const probe = read(document);
  const session = probe.session;
  return {
    blocked: session === null || saveBlocked(probe, session) !== null,
    blocks: visibleBlocks(document).length,
    failure: probe.failure,
    open: session !== null,
    prefix: probe.prefix,
    scope: session?.scope ?? null,
  };
});

export const recurringEditsTouchOnlyTheirScope = always(() => current.current.failure === null);

/** Picks a group by weight, then an action in it uniformly; empty groups drop out. */
const weighted = (
  groups: ReadonlyArray<readonly [number, ReadonlyArray<ActionTemplate>]>,
): Tree<ActionTemplate> => ({
  branches: groups
    .filter(([, group]) => group.length > 0)
    .map(([weight, group]) => [
      weight,
      { branches: group.map((action): [number, Tree<ActionTemplate>] => [1, { value: action }]) },
    ]),
});

const SCOPES: ReadonlyArray<Scope> = ['instance', 'following', 'series'];

export const recurringEditorActions = actions(() => {
  const state = current.current;
  if (state.failure !== null) {
    return [];
  }
  if (state.prefix < PREFIX_STEPS) {
    return [prefixStep(state.prefix)];
  }
  if (!state.open) {
    // Moves can empty the visible week; nothing is left to open then.
    // Each scope gets a third of the sessions: once a series holds edited
    // occurrences, "This event" would otherwise win most saves.
    return state.blocks === 0
      ? ['Wait']
      : weighted(
          SCOPES.map((scope) => [
            1,
            Array.from({ length: state.blocks }, (_, index) => openOccurrence(index, scope)),
          ]),
        );
  }
  return weighted([
    [3, TIMES.map((_, choice) => retime(choice))],
    [
      1,
      [...DAY_OFFSETS, ...(state.blocks > 4 ? [FAR_OFFSET] : [])].map((offset) => redate(offset)),
    ],
    [1, SCOPES.filter((scope) => scope !== state.scope).map((scope) => pickScope(scope))],
    [3, state.blocked ? [] : [save(2), save(5), save(10)]],
    [1, [cancelAndReopen()]],
  ]);
});
