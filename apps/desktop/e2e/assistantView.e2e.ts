import {
  Account,
  Attendee,
  CalendarInfo,
  EventRecord,
  EventReminders,
  GoogleContact,
  ReminderOverride,
  Temporal,
} from '@calendar/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents, readPendingOps } from './harness.ts';

// The editor's two views of one draft. Assistant is a conversation: what
// was said, and the item as a card with what the step changed marked;
// Form is the fields. Under both, one history of steps — a phrase, an
// edit by hand, a choice picked — which the footer goes back and forward
// through: an older step is looked at (the form locked, Save off) until
// "Use this" keeps it and lets the later ones go. A saved item's steps
// start from "As saved", and Save sends only what differs from it. The
// model is the deterministic fixture (`Title | +N | HH:MM-HH:MM | Place`,
// an empty part meaning "unchanged", `invite …` at the end), the places
// come from the geo fixture, and the device zone is pinned so the seeded
// hours are the ones the form shows on every host.
const TZ = 'Europe/Vienna';
const today = Temporal.Now.plainDateISO(TZ);
const at = (hour: number, minute = 0, day = today): number =>
  day.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, minute), timeZone: TZ }).toInstant()
    .epochMilliseconds;

const stored = (
  id: string,
  title: string,
  startUtc: number,
  endUtc: number,
  extra: Partial<EventRecord> = {},
) =>
  new EventRecord({
    accountId: 'acc-e2e',
    calendarId: 'cal-e2e',
    endUtc,
    etag: '"1"',
    id,
    isAllDay: false,
    startTimeZone: TZ,
    startUtc,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...extra,
  });

const seed = {
  accounts: [
    new Account({
      contactsEnabled: true,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#16a34a',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Personal',
      timeZone: TZ,
    }),
  ],
  contacts: [
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Sarah Keller',
      email: 'sarah@example.com',
      isOther: false,
      resourceName: 'people/c1',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Tom Brandt',
      email: 'tom.brandt@example.com',
      isOther: false,
      resourceName: 'people/c2',
    }),
    new GoogleContact({
      accountId: 'acc-e2e',
      displayName: 'Tom Weiss',
      email: 'tom.weiss@example.com',
      isOther: true,
      resourceName: 'otherContacts/o1',
    }),
  ],
  events: [
    // A stored event with everything a careless Save would re-send: its
    // own notification, a guest list, a place and notes.
    stored('evt-review', 'Design review', at(15), at(16), {
      attendees: [
        new Attendee({ email: 'e2e@example.com', isOrganizer: true, responseStatus: 'accepted' }),
        new Attendee({ email: 'bob@example.com', responseStatus: 'needsAction' }),
      ],
      description: 'Bring the slides',
      location: 'Room 4',
      reminders: new EventReminders({
        overrides: [new ReminderOverride({ method: 'popup', minutes: 45 })],
        useDefault: false,
      }),
    }),
    // A series, opened at one occurrence.
    stored(
      'evt-daily',
      'Daily sync',
      at(9, 0, today.subtract({ days: 2 })),
      at(9, 30, today.subtract({ days: 2 })),
      {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=14'],
      },
    ),
  ],
};
const geo = {
  fixture: {
    places: [
      {
        lat: 48.209,
        lng: 16.375,
        name: 'Figlmüller',
        subtitle: 'Wollzeile 5, 1010 Wien',
        title: 'Figlmüller',
      },
      {
        lat: 48.212,
        lng: 16.379,
        name: 'Figlmüller',
        subtitle: 'Bäckerstraße 6, 1010 Wien',
        title: 'Figlmüller Bäckerstrasse',
      },
    ],
  },
};

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const COMMAND_N = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))`;
const INPUT = `document.querySelector('[data-testid="quick-add-input"]')`;
const TITLE = 'input[placeholder="Title"]';
const START = 'input[aria-label="Start time"]';
const exists = (testId: string) => `!!document.querySelector('[data-testid="${testId}"]')`;
const textOf = (testId: string) =>
  `(document.querySelector('[data-testid="${testId}"]')?.textContent ?? '')`;
const headingIs = (text: string) => `${textOf('editor-title')} === ${JSON.stringify(text)}`;
const view = `document.querySelector('[data-testid="editor"]')?.dataset.view`;
const card = (part: string) => textOf(`assistant-card-${part}`);
const changed = textOf('assistant-changed');
const stepPosition = textOf('step-position');
const said = `document.querySelectorAll('[data-testid="assistant-said"]').length`;
const versions = `document.querySelectorAll('[data-testid="assistant-version"]').length`;
const valueOf = (selector: string) =>
  `(document.querySelector(${JSON.stringify(selector)})?.value ?? '')`;
const marked = (selector: string) =>
  `(document.querySelector(${JSON.stringify(selector)})?.dataset.marked === '')`;
const locked = `document.querySelector(${JSON.stringify(TITLE)})?.matches(':disabled') === true`;
const saveIsOff = `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save')?.disabled === true`;
const guests = `[...document.querySelectorAll('[data-invitee]')].map((chip) => chip.getAttribute('data-invitee'))`;
// On the grid: the draft's hatched block, and the outline where a step moved it from.
const blockAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-block"][data-draft-start="${start}"]')`;
const wasAt = (start: string) =>
  `!!document.querySelector('[data-testid="draft-was"][data-draft-start="${start}"]')`;
const traces = `document.querySelectorAll('[data-testid="draft-was"]').length`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('The editor’s Assistant and Form views', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed, { env: { TZ }, geo, model: 'fixture' });
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });
  afterEach(async () => {
    // A failure above must not strand an editor for the next test.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await app.cdp.eval<boolean>(exists('editor')))) {
        return;
      }
      await app.cdp.pressEscape();
      await sleep(150);
    }
  });

  /** The updates queued for one stored event. */
  const updatesOf = async (eventId: string) =>
    (await readPendingOps(app.userDataDir)).filter(
      (op) => op.kind === 'update' && op.eventId === eventId,
    );

  it('answers each phrase with the item as a card, marks what changed and asks what it must; steps back through it all, and saves the step kept with "Use this"', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(headingIs('New event'));
    // A new item opens on the Assistant, its field ready; nothing to step through yet.
    expect(await cdp.eval<string>(view)).toBe('assistant');
    await cdp.waitFor(`document.activeElement === ${INPUT}`);
    expect(await cdp.eval<boolean>(exists('step-control'))).toBe(false);

    await cdp.say('Lunch with Sarah | +1 | 13:00-14:00 | Figlmüller | invite Sarah Keller');
    await cdp.waitFor(`${card('title')} === 'Lunch with Sarah'`);
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);
    expect(await cdp.eval<string>(card('time'))).toBe('13:00–14:00');
    expect(await cdp.eval<string>(card('location'))).toBe('Figlmüller, Wollzeile 5, 1010 Wien');
    expect(await cdp.eval<string>(card('guests'))).toBe('Sarah Keller');
    // The step made the item: all of it is new, nothing "changed" — and
    // on the grid a block, with nowhere it was before.
    expect(await cdp.eval<string>(changed)).toBe('');
    await cdp.waitFor(blockAt('13:00'));
    expect(await cdp.eval<number>(traces)).toBe(0);

    // A change: the hours marked, the ones before struck through after
    // them — and a question, since two contacts are called Tom.
    await cdp.say('| | 12:30-13:30 | | invite Tom');
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    expect(await cdp.eval<string>(card('time'))).toBe('12:30–13:3013:00–14:00');
    expect(await cdp.eval<string>(changed)).toBe('Changed: time');
    // The grid: the block where it is now, a dashed outline where it was.
    await cdp.waitFor(blockAt('12:30'));
    await cdp.waitFor(wasAt('13:00'));
    await cdp.waitFor(exists('draft-invitee-choices'));
    expect(await cdp.eval<string>(textOf('draft-invitee-choice-0'))).toContain('Which Tom?');
    // One phrase is one step: the form taking the draft in adds none.
    await sleep(500);
    expect(await cdp.eval<string>(stepPosition)).toBe('2 of 2');
    expect(await cdp.eval<number>(said)).toBe(2);
    expect(await cdp.eval<number>(versions)).toBe(1);

    // The answer is a step of its own: the guest who joined is the one marked.
    await cdp.clickTestId('draft-invitee-pick-0-0');
    await cdp.waitFor(`${stepPosition} === '3 of 3'`);
    await cdp.waitFor(`${card('guests')} === 'Sarah Keller, Tom Brandt'`);
    expect(await cdp.eval<string>(changed)).toBe('Changed: guests');
    expect(await cdp.eval<boolean>(exists('draft-invitee-choices'))).toBe(false);
    // This step moved nothing: the outline is the step's, and goes with it.
    await cdp.waitFor(`${traces} === 0`);

    // The form: the same draft, the same step's mark.
    await cdp.clickTestId('assistant-edit');
    await cdp.waitFor(`${view} === 'form'`);
    expect(await cdp.eval<string>(valueOf(TITLE))).toBe('Lunch with Sarah');
    expect(await cdp.eval<string>(valueOf(START))).toBe('12:30');
    expect(await cdp.eval<Array<string>>(guests)).toEqual([
      'sarah@example.com',
      'tom.brandt@example.com',
    ]);
    expect(await cdp.eval<boolean>(marked('[data-testid="event-invitees"]'))).toBe(true);
    expect(await cdp.eval<boolean>(marked(START))).toBe(false);

    // Three steps, the form on show, free to edit.
    expect(await cdp.eval<string>(stepPosition)).toBe('3 of 3');
    expect(await cdp.eval<boolean>(locked)).toBe(false);

    // One back: before Tom was picked. Looked at, not edited.
    await cdp.clickTestId('step-back');
    await cdp.waitFor(`${stepPosition} === '2 of 3'`);
    await cdp.waitFor(exists('step-preview'));
    expect(await cdp.eval<string>(textOf('step-name'))).toBe('“| | 12:30-13:30 | | invite Tom”');
    expect(await cdp.eval<Array<string>>(guests)).toEqual(['sarah@example.com']);
    expect(await cdp.eval<boolean>(locked)).toBe(true);
    expect(await cdp.eval<boolean>(saveIsOff)).toBe(true);
    // What that step changed is what is marked now, on the grid too.
    await cdp.waitFor(wasAt('13:00'));
    expect(await cdp.eval<boolean>(marked(START))).toBe(true);
    expect(await cdp.eval<boolean>(marked('[data-testid="event-invitees"]'))).toBe(false);

    // Further back, and forward again: nothing is lost by looking.
    await cdp.clickTestId('step-back');
    await cdp.waitFor(`${stepPosition} === '1 of 3'`);
    expect(await cdp.eval<string>(valueOf(START))).toBe('13:00');
    await cdp.clickTestId('step-forward');
    await cdp.clickTestId('step-forward');
    await cdp.waitFor(`${stepPosition} === '3 of 3'`);
    await cdp.waitFor(`!${exists('step-preview')}`);
    expect(await cdp.eval<boolean>(locked)).toBe(false);
    expect(await cdp.eval<boolean>(saveIsOff)).toBe(false);
    expect(await cdp.eval<Array<string>>(guests)).toEqual([
      'sarah@example.com',
      'tom.brandt@example.com',
    ]);

    // The conversation shows the same: Restore on a row puts that version
    // on show, the later ones dimmed, the field and the microphone off.
    await cdp.showEditorView('assistant');
    await cdp.clickTestId('assistant-restore');
    await cdp.waitFor(`${stepPosition} === '1 of 3'`);
    expect(await cdp.eval<string>(card('time'))).toBe('13:00–14:00');
    expect(await cdp.eval<boolean>(`${INPUT}.disabled`)).toBe(true);
    await cdp.clickTestId('step-forward');
    await cdp.waitFor(`${stepPosition} === '2 of 3'`);

    // "Use this": the step is kept, the pick after it gone — and asked again.
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    await cdp.waitFor(exists('draft-invitee-choices'));
    expect(await cdp.eval<boolean>(exists('step-preview'))).toBe(false);
    expect(await cdp.eval<string>(card('guests'))).toBe('Sarah Keller');

    // Save writes what is shown: 12:30, Sarah alone.
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!${exists('editor')}`);
    const tomorrow = today.add({ days: 1 });
    await expect
      .poll(async () => {
        const lunch = (await readEvents(app.userDataDir)).find(
          (event) => event.title === 'Lunch with Sarah',
        );
        return lunch
          ? {
              attendees: lunch.attendees?.map((attendee) => attendee.email),
              location: lunch.location,
              startUtc: lunch.startUtc,
            }
          : undefined;
      })
      .toEqual({
        attendees: ['sarah@example.com'],
        location: 'Figlmüller, Wollzeile 5, 1010 Wien',
        startUtc: at(12, 30, tomorrow),
      });
  });

  it('counts an edit by hand as a step, further typing in the same field as the same one', async () => {
    const { cdp } = app;
    await cdp.eval(COMMAND_N);
    await cdp.waitFor(headingIs('New event'));
    await cdp.say('Call | +1 | 10:00-10:30');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);

    await cdp.showEditorView('form');
    await cdp.type(TITLE, ' the bank');
    await cdp.waitFor(`${stepPosition} === '2 of 2'`);
    await cdp.type(TITLE, ' today');
    await sleep(400);
    expect(await cdp.eval<string>(stepPosition)).toBe('2 of 2');
    // Another field is another step.
    await cdp.type('[data-testid="editor-notes"]', 'IBAN ready');
    await cdp.waitFor(`${stepPosition} === '3 of 3'`);

    // Back over the notes: the title as typed stays, the notes are gone — and named.
    await cdp.clickTestId('step-back');
    await cdp.waitFor(`${stepPosition} === '2 of 3'`);
    expect(await cdp.eval<string>(valueOf('[data-testid="editor-notes"]'))).toBe('');
    expect(await cdp.eval<string>(valueOf(TITLE))).toContain('the bank');
    expect(await cdp.eval<string>(textOf('step-preview'))).toContain('By hand');
    expect(await cdp.eval<string>(textOf('step-name'))).toBe('Title');
    // The conversation lists the edits among its versions.
    await cdp.showEditorView('assistant');
    expect(await cdp.eval<number>(said)).toBe(1);
    expect(
      await cdp.eval<string>(
        `[...document.querySelectorAll('[data-testid="assistant-version"]')].at(-1).textContent`,
      ),
    ).toContain('by hand');
    await cdp.pressEscape();
    await cdp.waitFor(`!${exists('editor')}`);
  });

  it('changes a saved event by phrase and sends only what differs; back at "As saved", Save sends nothing', async () => {
    const { cdp } = app;
    await cdp.openEditor('[title^="Design review"]');
    // A saved item opens on its form, with the Assistant a tab away.
    expect(await cdp.eval<string>(view)).toBe('form');
    await cdp.showEditorView('assistant');
    // Its thread starts as the item itself.
    await cdp.waitFor(`${card('title')} === 'Design review'`);
    expect(await cdp.eval<string>(textOf('assistant-card'))).toContain('As saved');
    expect(await cdp.eval<string>(card('time'))).toBe('15:00–16:00');
    expect(await cdp.eval<boolean>(exists('step-control'))).toBe(false);

    await cdp.say('| | 16:00-17:00');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);
    expect(await cdp.eval<string>(card('time'))).toBe('16:00–17:0015:00–16:00');
    expect(await cdp.eval<string>(changed)).toBe('Changed: time');
    // "As saved" is the row to go back to.
    expect(await cdp.eval<string>(textOf('assistant-version'))).toContain('As saved');
    // On the grid the draft is where it would go; the event's own block
    // shows where it was, so no outline is drawn over it.
    await cdp.waitFor(blockAt('16:00'));
    expect(await cdp.eval<number>(traces)).toBe(0);

    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!${exists('editor')}`);
    // The times, and nothing the event already had: its own
    // notification, its guests, its place and notes are as they were, and
    // no flag asks for them to be written again.
    await expect.poll(() => updatesOf('evt-review')).toHaveLength(1);
    const [update] = await updatesOf('evt-review');
    const { beforePayload: before, payload: after } = update!;
    expect(after).toMatchObject({ endUtc: at(17), startUtc: at(16), title: 'Design review' });
    expect(before).toMatchObject({ endUtc: at(16), startUtc: at(15) });
    expect(after?.reminders).toEqual(before?.reminders);
    expect(after?.reminders?.overrides.map((override) => override.minutes)).toEqual([45]);
    expect(after?.attendees).toEqual(before?.attendees);
    expect([after?.location, after?.description, after?.recurrence]).toEqual([
      'Room 4',
      'Bring the slides',
      undefined,
    ]);
    expect([
      update!.attendeesChanged,
      update!.remindersChanged,
      update!.recurrenceCleared,
      update!.geoCleared,
    ]).toEqual([undefined, undefined, undefined, undefined]);

    // Again, and back to the start: kept, there is nothing to send.
    await cdp.openEditor('[title^="Design review"]');
    await cdp.showEditorView('assistant');
    await cdp.waitFor(`${card('time')} === '16:00–17:00'`);
    await cdp.say('Design review (moved) | | 18:00-19:00');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);
    await cdp.clickTestId('assistant-undo');
    await cdp.waitFor(`${stepPosition} === 'Start'`);
    expect(await cdp.eval<string>(textOf('step-name'))).toBe('As saved');
    expect(await cdp.eval<string>(valueOf(TITLE))).toBe('Design review');
    await cdp.clickTestId('step-use');
    await cdp.waitFor(`!${exists('step-control')}`);
    await cdp.clickButtonWithText('Save');
    await cdp.waitFor(`!${exists('editor')}`);
    await sleep(300);
    const again = await updatesOf('evt-review');
    expect(again).toHaveLength(1);
    expect(again[0]?.payload).toEqual(after);
  });

  it('refuses in the conversation what a saved event cannot hold, and lands nothing', async () => {
    const { cdp } = app;
    // A single stored event cannot be given a rule by an update.
    await cdp.openEditor('[title^="Design review"]');
    await cdp.showEditorView('assistant');
    await cdp.waitFor(`${card('title')} === 'Design review'`);
    await cdp.say('every week');
    await cdp.waitFor(
      `${textOf('quick-add-status')} === 'How this event repeats can’t be changed here.'`,
    );
    // Nothing landed, and the words are still there to change.
    expect(await cdp.eval<boolean>(exists('step-control'))).toBe(false);
    expect(await cdp.eval<string>(`${INPUT}.value`)).toBe('every week');
    await cdp.pressEscape();
    await cdp.pressEscape();
    await cdp.waitFor(`!${exists('editor')}`);

    // One occurrence of a series: the rule is the series', which "This event" cannot change.
    await cdp.openEditor('[title^="Daily sync"]');
    await cdp.showEditorView('assistant');
    await cdp.waitFor(`${card('title')} === 'Daily sync'`);
    // The scope a phrase applies at is asked under the card.
    expect(await cdp.eval<boolean>(exists('draft-scope'))).toBe(true);
    await cdp.say('every week');
    await cdp.waitFor(
      `${textOf('quick-add-status')} === 'Choose “All events” or “This and following” to change how it repeats.'`,
    );
    expect(await cdp.eval<boolean>(exists('step-control'))).toBe(false);
    // What it can hold lands: this occurrence, half an hour later.
    await cdp.eval(`${INPUT}.select()`);
    await cdp.say('| | 09:30-10:00');
    await cdp.waitFor(`${stepPosition} === '1 of 1'`);
    expect(await cdp.eval<string>(card('time'))).toBe('09:30–10:0009:00–09:30');
  });
});
