import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

interface Form {
  readonly date: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly startTime: string;
  readonly title: string;
}

interface Probe {
  cancelled: number;
  failure: string | null;
  opened: number;
  saved: Array<Form>;
  seedChecked: boolean;
  session: { changedDate: boolean; original: Form } | null;
}

const read = (document: Document): Probe =>
  JSON.parse(
    document.body.dataset['bombadilProbe'] ??
      '{"cancelled":0,"failure":null,"opened":0,"saved":[],"seedChecked":false,"session":null}',
  ) as Probe;

const write = (document: Document, probe: Probe): void => {
  document.body.dataset['bombadilProbe'] = JSON.stringify(probe);
};

const waitFor = async (holds: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() >= deadline) {
      throw new Error('Editor did not reach the expected state within 10 seconds');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  await waitFor(() => field(document, label).value === value);
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

const showForm = async (document: Document): Promise<void> => {
  await waitFor(() => document.querySelector('[data-testid="editor"]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid="editor-view-form"]')?.click();
  await waitFor(() => {
    const pane = document.querySelector('[data-testid="editor-form"]');
    return pane !== null && !pane.hasAttribute('inert') && pane.getBoundingClientRect().height > 0;
  });
};

const cancel = async (document: Document): Promise<void> => {
  button(document, 'Cancel').click();
  await waitFor(
    () =>
      document.querySelector('[data-testid="editor"]') === null ||
      document.querySelector('[data-testid="discard-confirm-yes"]') !== null,
  );
  document.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-yes"]')?.click();
  await waitFor(() => document.querySelector('[data-testid="editor"]') === null);
};

const openExisting = async (document: Document): Promise<void> => {
  const event = document.querySelector<HTMLElement>('[data-testid="timed-event-bombadil-seed"]');
  if (!event) {
    throw new Error('Seed event missing');
  }
  event.scrollIntoView({ block: 'center', inline: 'nearest' });
  event.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await waitFor(() => document.querySelector('[data-testid="inspector-edit"]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid="inspector-edit"]')!.click();
  await showForm(document);
};

const openNew = async (document: Document): Promise<void> => {
  document.querySelector<HTMLButtonElement>('button[aria-label="New event"]')!.click();
  await showForm(document);
};

const checked = async (document: Document, run: () => Promise<void>): Promise<void> => {
  document.body.dataset['bombadilBusy'] = 'true';
  try {
    await run();
  } catch (error) {
    const probe = read(document);
    probe.failure = error instanceof Error ? error.message : String(error);
    write(document, probe);
  } finally {
    document.body.dataset['bombadilBusy'] = 'false';
  }
};

const checkCancelledEdit = registerCustomAction('cancel-existing-and-reopen', async (document) => {
  await checked(document, async () => {
    await openExisting(document);
    const original = form(document);
    const dates = JSON.parse(document.body.dataset['bombadilDates']!) as Array<string>;
    await setField(document, 'Date', dates[1]!);
    await setField(document, 'End date', dates[2]!);
    await setField(document, 'Title', 'This edit must never be saved');
    await cancel(document);
    await openExisting(document);
    if (JSON.stringify(form(document)) !== JSON.stringify(original)) {
      throw new Error('Cancelling an existing event retained changes when reopened');
    }
    await cancel(document);
    const probe = read(document);
    probe.cancelled += 1;
    probe.seedChecked = true;
    write(document, probe);
  });
});

const begin = registerCustomAction('open-new-editor', async (document) => {
  await checked(document, async () => {
    await openNew(document);
    const original = form(document);
    if (original.title !== '') {
      throw new Error('A new editor retained an earlier draft title');
    }
    const probe = read(document);
    probe.opened += 1;
    probe.session = { changedDate: false, original };
    write(document, probe);
    await setField(document, 'Title', `Bombadil event ${probe.opened}`);
    await setField(document, 'Start time', '10:00');
    await setField(document, 'End time', '11:00');
  });
});

const changeDate = registerCustomAction(
  'change-event-date',
  async (document, _window, date: string) => {
    await checked(document, async () => {
      await setField(document, 'Date', date);
      await setField(document, 'End date', date);
      const probe = read(document);
      probe.session!.changedDate = true;
      write(document, probe);
    });
  },
);

const saveBurst = registerCustomAction(
  'save-repeatedly',
  async (document, _window, count: number) => {
    await checked(document, async () => {
      const expected = form(document);
      const save = button(document, 'Save');
      // No waits between clicks: exercise repeated activation while the
      // save is pending, including before React can disable the button.
      for (let press = 0; press < count; press += 1) {
        save.click();
      }
      await waitFor(() => document.querySelector('[data-testid="editor"]') === null);
      const probe = read(document);
      probe.saved.push(expected);
      probe.session = null;
      write(document, probe);
    });
  },
);

const cancelNew = registerCustomAction('cancel-new-and-reopen', async (document) => {
  await checked(document, async () => {
    const original = read(document).session!.original;
    await cancel(document);
    await openNew(document);
    const reopened = form(document);
    if (
      reopened.title !== '' ||
      reopened.date !== original.date ||
      reopened.endDate !== original.endDate
    ) {
      throw new Error('Cancelling a new event retained its title or date when reopened');
    }
    await cancel(document);
    const probe = read(document);
    probe.cancelled += 1;
    probe.session = null;
    write(document, probe);
  });
});

const current = extract(({ document }) => {
  const probe = read(document);
  return {
    changedDate: probe.session?.changedDate ?? false,
    dates: JSON.parse(document.body.dataset['bombadilDates'] ?? '[]') as Array<string>,
    failure: probe.failure,
    open: probe.session !== null,
    saved: probe.saved.length,
    seedChecked: probe.seedChecked,
  };
});

export const editorChangesRespectCancel = always(() => current.current.failure === null);

export const editorActions = actions(() => {
  const state = current.current;
  if (state.failure !== null) {
    return [];
  }
  if (!state.seedChecked) {
    return [checkCancelledEdit()];
  }
  if (!state.open) {
    return [begin()];
  }
  const dates = state.dates.map((date) => changeDate(date));
  if (!state.changedDate) {
    return dates;
  }
  if (state.saved === 0) {
    return [saveBurst(5)];
  }
  return [...dates, saveBurst(2), saveBurst(5), saveBurst(10), cancelNew()];
});
