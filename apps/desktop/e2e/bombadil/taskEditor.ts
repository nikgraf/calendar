import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

type Kind = 'event' | 'task' | 'reminder';
interface Draft {
  date: string;
  kind: Kind;
  notes: string;
  title: string;
}
interface Session extends Draft {
  changedDate: boolean;
  initialDate: string;
  switches: number;
  target: 'task' | 'reminder';
}
interface Probe {
  cancelled: number;
  failure: string | null;
  opened: number;
  saved: Array<Draft>;
  seedsChecked: boolean;
  session: Session | null;
}
const read = (document: Document): Probe =>
  JSON.parse(
    document.body.dataset['bombadilTaskProbe'] ??
      '{"cancelled":0,"failure":null,"opened":0,"saved":[],"seedsChecked":false,"session":null}',
  ) as Probe;
const write = (document: Document, probe: Probe) => {
  document.body.dataset['bombadilTaskProbe'] = JSON.stringify(probe);
};
const waitFor = async (holds: () => boolean) => {
  const until = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() >= until) {
      throw new Error('Task editor did not reach the expected state');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const input = (document: Document, selector: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-testid="editor"] ${selector}`,
  );
  if (!found) {
    throw new Error(`Missing task editor field: ${selector}`);
  }
  return found;
};
const setValue = async (document: Document, selector: string, value: string) => {
  const element = input(document, selector);
  element.scrollIntoView({ block: 'center' });
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => input(document, selector).value === value);
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const button = (document: Document, label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="editor"] button'),
  ].find((element) => element.textContent.trim() === label);
  if (!found) {
    throw new Error(`Missing editor button: ${label}`);
  }
  found.scrollIntoView({ block: 'center' });
  return found;
};
const showForm = async (document: Document) => {
  await waitFor(() => document.querySelector('[data-testid="editor"]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid="editor-view-form"]')?.click();
  await waitFor(() => {
    const pane = document.querySelector('[data-testid="editor-form"]');
    return pane !== null && !pane.hasAttribute('inert') && pane.getBoundingClientRect().height > 0;
  });
};
const cancel = async (document: Document) => {
  button(document, 'Cancel').click();
  await waitFor(
    () =>
      document.querySelector('[data-testid="editor"]') === null ||
      document.querySelector('[data-testid="discard-confirm-yes"]') !== null,
  );
  document.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-yes"]')?.click();
  await waitFor(() => document.querySelector('[data-testid="editor"]') === null);
};
const dateField = (kind: Kind): string =>
  kind === 'event'
    ? 'input[aria-label="Date"]'
    : kind === 'task'
      ? 'input[placeholder="YYYY-MM-DD"]'
      : 'input[type="date"]';
const titleField = 'input[placeholder="Title"]';
const notesField = 'textarea[placeholder="Add notes"]';
const assertDraft = (document: Document, draft: Draft) => {
  if (
    input(document, titleField).value !== draft.title ||
    input(document, dateField(draft.kind)).value !== draft.date
  ) {
    throw new Error('Switching editor kind lost the title or date');
  }
  if (draft.kind !== 'event' && input(document, notesField).value !== draft.notes) {
    throw new Error('Switching editor kind lost the notes');
  }
};
const switchTo = async (document: Document, kind: Kind) => {
  const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="mode-${kind}"]`);
  if (!toggle || toggle.disabled) {
    throw new Error(`Editor kind is unavailable: ${kind}`);
  }
  toggle.click();
  await waitFor(
    () =>
      document
        .querySelector('[data-testid="editor-title"]')
        ?.textContent?.trim()
        .toLowerCase()
        .endsWith(kind) === true,
  );
  await showForm(document);
};
const openNew = async (document: Document) => {
  document.querySelector<HTMLButtonElement>('[aria-label="New event"]')!.click();
  await showForm(document);
};
const checked = async (document: Document, run: () => Promise<void>) => {
  document.body.dataset['bombadilTaskBusy'] = 'true';
  try {
    await run();
  } catch (error) {
    const probe = read(document);
    probe.failure = error instanceof Error ? error.message : String(error);
    write(document, probe);
  } finally {
    document.body.dataset['bombadilTaskBusy'] = 'false';
  }
};

const checkSeeds = registerCustomAction(
  'cancel-stored-task-conversion-and-reminder-edit',
  async (document) =>
    checked(document, async () => {
      const dates = JSON.parse(document.body.dataset['bombadilTaskDates']!) as Array<string>;
      for (const kind of ['task', 'reminder'] as const) {
        const selector =
          kind === 'task'
            ? '[data-testid="all-day-task-bombadil-google-seed"]'
            : '[data-testid="timed-task-bombadil-reminder-seed"]';
        const open = async () => {
          await waitFor(() => document.querySelector(selector) !== null);
          const chip = document.querySelector<HTMLElement>(selector)!;
          chip.scrollIntoView({ block: 'center', inline: 'nearest' });
          chip.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
          await showForm(document);
        };
        await open();
        const original = {
          date: input(document, dateField(kind)).value,
          kind,
          notes: input(document, notesField).value,
          title: input(document, titleField).value,
        };
        await setValue(document, titleField, 'This cancelled task must not persist');
        await setValue(document, dateField(kind), dates[1]!);
        if (kind === 'task') {
          await switchTo(document, 'event');
          await setValue(document, dateField('event'), dates[2]!);
        }
        await cancel(document);
        await open();
        assertDraft(document, original);
        await cancel(document);
      }
      const probe = read(document);
      probe.seedsChecked = true;
      write(document, probe);
    }),
);

const begin = registerCustomAction(
  'begin-task-draft',
  async (document, _window, target: 'task' | 'reminder') =>
    checked(document, async () => {
      await openNew(document);
      if (input(document, titleField).value !== '') {
        throw new Error('A new draft retained a title');
      }
      const initialDate = input(document, dateField('event')).value;
      await switchTo(document, target);
      const probe = read(document);
      probe.opened += 1;
      const session: Session = {
        changedDate: false,
        date: initialDate,
        initialDate,
        kind: target,
        notes: `Notes for task ${probe.opened}`,
        switches: 0,
        target,
        title: `Bombadil task ${probe.opened}`,
      };
      await setValue(document, titleField, session.title);
      await setValue(document, notesField, session.notes);
      assertDraft(document, session);
      probe.session = session;
      write(document, probe);
    }),
);

const changeKind = registerCustomAction(
  'switch-task-editor-kind',
  async (document, _window, kind: Kind) =>
    checked(document, async () => {
      const probe = read(document);
      await switchTo(document, kind);
      const session = probe.session!;
      session.kind = kind;
      session.switches += 1;
      assertDraft(document, session);
      write(document, probe);
    }),
);

const changeDate = registerCustomAction(
  'change-task-due-date',
  async (document, _window, date: string) =>
    checked(document, async () => {
      const probe = read(document);
      const session = probe.session!;
      await setValue(document, dateField(session.kind), date);
      if (session.kind === 'event') {
        await setValue(document, 'input[aria-label="End date"]', date);
      }
      session.date = date;
      session.changedDate = true;
      assertDraft(document, session);
      write(document, probe);
    }),
);

const saveBurst = registerCustomAction(
  'save-task-repeatedly',
  async (document, _window, count: number) =>
    checked(document, async () => {
      const probe = read(document);
      const session = probe.session!;
      if (session.kind === 'event') {
        throw new Error('Task save unexpectedly reached the event editor');
      }
      assertDraft(document, session);
      const list = document.querySelector<HTMLSelectElement>('[aria-label="Task list"]')!.value;
      if (
        list !==
        (session.kind === 'task'
          ? 'acc-bombadil-tasks:list-bombadil'
          : 'apple-reminders:reminders-bombadil')
      ) {
        throw new Error('Editor kind selected the wrong provider list');
      }
      const save = button(document, 'Save');
      for (let press = 0; press < count; press += 1) {
        save.click();
      }
      await waitFor(() => document.querySelector('[data-testid="editor"]') === null);
      probe.saved.push({
        date: session.date,
        kind: session.kind,
        notes: session.notes,
        title: session.title,
      });
      probe.session = null;
      write(document, probe);
    }),
);

const cancelNew = registerCustomAction('cancel-task-draft-and-reopen', async (document) =>
  checked(document, async () => {
    const probe = read(document);
    const session = probe.session!;
    await cancel(document);
    await openNew(document);
    await switchTo(document, session.target);
    assertDraft(document, {
      date: session.initialDate,
      kind: session.target,
      notes: '',
      title: '',
    });
    await cancel(document);
    probe.cancelled += 1;
    probe.session = null;
    write(document, probe);
  }),
);

const current = extract(({ document }) => {
  const probe = read(document);
  return {
    cancelled: probe.cancelled,
    dates: JSON.parse(document.body.dataset['bombadilTaskDates'] ?? '[]') as Array<string>,
    failure: probe.failure,
    savedReminder: probe.saved.some((draft) => draft.kind === 'reminder'),
    savedTask: probe.saved.some((draft) => draft.kind === 'task'),
    seedsChecked: probe.seedsChecked,
    session: probe.session === null ? null : { ...probe.session },
  };
});
export const taskDraftsRespectCancelAndKind = always(() => current.current.failure === null);
export const taskEditorActions = actions(() => {
  const state = current.current;
  if (state.failure !== null) {
    return [];
  }
  if (!state.seedsChecked) {
    return [checkSeeds()];
  }
  const session = state.session;
  if (!session) {
    return state.cancelled === 0 || !state.savedTask
      ? [begin('task')]
      : !state.savedReminder
        ? [begin('reminder')]
        : [begin('task'), begin('reminder')];
  }
  if (session.switches === 0) {
    return [changeKind('event')];
  }
  if (session.kind === 'event') {
    return [changeKind(session.target)];
  }
  if (!session.changedDate) {
    return state.dates.slice(1).map((date) => changeDate(date));
  }
  if (state.cancelled === 0) {
    return [cancelNew()];
  }
  if (!state.savedTask || !state.savedReminder) {
    return [saveBurst(5)];
  }
  return [
    ...state.dates.map((date) => changeDate(date)),
    changeKind('event'),
    changeKind(session.kind === 'task' ? 'reminder' : 'task'),
    saveBurst(2),
    saveBurst(5),
    saveBurst(10),
    cancelNew(),
  ];
});
