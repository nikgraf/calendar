import { describe, expect, it } from 'vite-plus/test';
import {
  discardQuestion,
  editorDiscard,
  editorUnsaved,
  formChange,
  formReading,
} from './editorUnsaved.ts';

const unsaved = (over: Partial<Parameters<typeof editorUnsaved>[0]>) =>
  editorUnsaved({
    assistant: 'new',
    canSave: true,
    drafts: 0,
    formChanged: false,
    previewing: false,
    userEdits: 0,
    writing: false,
    ...over,
  });

const discard = (over: Partial<Parameters<typeof editorDiscard>[0]>) =>
  editorDiscard({
    assistant: 'new',
    draftKinds: [],
    formChanged: false,
    kind: 'event',
    mode: 'event',
    previewing: false,
    readOnly: { event: false, todo: false },
    sourceKind: 'new',
    userEdits: 0,
    writing: false,
    ...over,
  });

const step = (over: Partial<Parameters<typeof formChange>[0]>) =>
  formChange({
    isNew: true,
    mode: 'event',
    opened: { event: 'seed' },
    reading: 'seed',
    switched: false,
    untouched: true,
    ...over,
  });

describe('editorUnsaved', () => {
  it('lets a new item close as it opened: a slot, a "+", the lesson phrase in its field', () => {
    expect(unsaved({})).toBe(false);
  });

  it('asks about a new item whose form changed', () => {
    expect(unsaved({ formChanged: true })).toBe(true);
  });

  it("asks about a new item's drafts, a share's untouched ones too", () => {
    expect(unsaved({ drafts: 1 })).toBe(true);
    expect(unsaved({ drafts: 3 })).toBe(true);
  });

  it('asks about a saved item only when its form differs from how it opened', () => {
    expect(unsaved({ assistant: 'saved', drafts: 1 })).toBe(false);
    expect(unsaved({ assistant: 'saved', drafts: 1, formChanged: true })).toBe(true);
  });

  it('does not count edits by hand put back as they were', () => {
    expect(unsaved({ assistant: 'saved', drafts: 1, formChanged: false, userEdits: 4 })).toBe(
      false,
    );
    expect(unsaved({ formChanged: false, userEdits: 2 })).toBe(false);
  });

  it('asks while an older step is on show: the newest one holds the steps', () => {
    expect(unsaved({ previewing: true })).toBe(true);
    expect(unsaved({ assistant: 'saved', previewing: true })).toBe(true);
  });

  it('measures a Convert editor by its edits by hand: its form fills as it opens', () => {
    expect(unsaved({ assistant: 'none', formChanged: true })).toBe(false);
    expect(unsaved({ assistant: 'none', userEdits: 1 })).toBe(true);
  });

  it('never asks where nothing can be written: a birthday, a read-only item', () => {
    expect(unsaved({ canSave: false, drafts: 2, formChanged: true, previewing: true })).toBe(false);
    expect(unsaved({ assistant: 'none', canSave: false, userEdits: 3 })).toBe(false);
  });
});

describe('discardQuestion', () => {
  it('names the new item by its kind', () => {
    expect(discardQuestion({ count: 1, isNew: true, noun: 'event' })).toBe(
      'Are you sure you want to discard this new event?',
    );
    expect(discardQuestion({ count: 1, isNew: true, noun: 'reminder' })).toBe(
      'Are you sure you want to discard this new reminder?',
    );
  });

  it("counts a share's drafts", () => {
    expect(discardQuestion({ count: 3, isNew: true, noun: 'event' })).toBe(
      'Are you sure you want to discard these 3 new events?',
    );
  });

  it('asks about the changes to a saved item', () => {
    expect(discardQuestion({ count: 1, isNew: false, noun: 'task' })).toBe(
      'Are you sure you want to discard your changes?',
    );
  });
});

describe('editorDiscard', () => {
  it('asks about a form that changed', () => {
    expect(discard({}).unsaved).toBe(false);
    expect(discard({ formChanged: true }).unsaved).toBe(true);
  });

  it('goes by the model on show: a read-only list holds nothing to discard', () => {
    expect(
      discard({
        assistant: 'saved',
        formChanged: true,
        mode: 'todo',
        readOnly: { event: false, todo: true },
        sourceKind: 'task',
      }).unsaved,
    ).toBe(false);
  });

  it('lets the editor go while its Save is under way: the write lands either way', () => {
    expect(discard({ draftKinds: ['event'], formChanged: true, writing: true }).unsaved).toBe(
      false,
    );
    expect(
      discard({ assistant: 'saved', formChanged: true, sourceKind: 'event', writing: true })
        .unsaved,
    ).toBe(false);
  });

  it("still asks about a capture's other drafts while one of them is saved", () => {
    expect(discard({ draftKinds: ['event', 'event'], writing: true }).unsaved).toBe(true);
  });

  it('never asks for a birthday', () => {
    expect(discard({ draftKinds: ['event'], sourceKind: 'birthday' }).unsaved).toBe(false);
  });

  it('names several drafts together: events, or items where the kinds differ', () => {
    expect(discard({ draftKinds: ['event', 'event'] }).question).toBe(
      'Are you sure you want to discard these 2 new events?',
    );
    expect(discard({ draftKinds: ['event', 'task', 'event'] }).question).toBe(
      'Are you sure you want to discard these 3 new items?',
    );
    expect(discard({ draftKinds: ['task'], kind: 'reminder' }).question).toBe(
      'Are you sure you want to discard this new reminder?',
    );
    expect(discard({ kind: 'task', sourceKind: 'event' }).question).toBe(
      'Are you sure you want to discard your changes?',
    );
  });
});

describe('formChange', () => {
  it('compares the form with its opening, and a field put back is none', () => {
    expect(step({})).toEqual({ changed: false, open: false });
    expect(step({ reading: 'typed' })).toEqual({ changed: true, open: false });
  });

  it("reads a saved item's opening as the editor opens", () => {
    expect(step({ isNew: false, opened: {}, reading: 'saved' })).toEqual({
      changed: false,
      open: true,
    });
  });

  it("opens a new item's form afresh after an untouched kind switch, round trips and lists too", () => {
    // Event → Task: the to-do form's first opening.
    expect(step({ mode: 'todo', reading: 'task', switched: true })).toEqual({
      changed: false,
      open: true,
    });
    // Task → Event: the event form again, as the to-do's values made it.
    expect(
      step({ opened: { event: 'seed', todo: 'task' }, reading: 'adopted', switched: true }),
    ).toEqual({ changed: false, open: true });
    // Task → Reminder: the same mode, another list.
    expect(
      step({ mode: 'todo', opened: { todo: 'task' }, reading: 'reminder', switched: true }),
    ).toEqual({ changed: false, open: true });
  });

  it('counts a switch after something was put in, and a saved item switched, as changed', () => {
    expect(step({ mode: 'todo', reading: 'task', switched: true, untouched: false })).toEqual({
      changed: true,
      open: false,
    });
    expect(step({ isNew: false, mode: 'todo', reading: 'task', switched: true })).toEqual({
      changed: true,
      open: false,
    });
    expect(
      step({
        isNew: false,
        mode: 'todo',
        opened: { todo: 'task' },
        reading: 'reminder',
        switched: true,
      }),
    ).toEqual({ changed: true, open: false });
  });
});

const event = (recurrence?: { readonly freq: 'weekly' }) =>
  ({
    kind: 'event',
    prefill: {
      date: '2026-11-16',
      endTime: '10:00',
      isAllDay: false,
      startTime: '09:00',
      title: 'Standup',
      ...(recurrence ? { recurrence } : {}),
    },
  }) as const;

describe('formReading', () => {
  it("leaves a series' rule out until it is the person's: one that arrives late is no change", () => {
    expect(formReading({ extras: {}, item: event({ freq: 'weekly' }), ruleDirty: false })).toBe(
      formReading({ extras: {}, item: event(), ruleDirty: false }),
    );
  });

  it('reads a rule the person took away: "Does not repeat" is a change', () => {
    expect(formReading({ extras: {}, item: event(), ruleDirty: true })).not.toBe(
      formReading({ extras: {}, item: event({ freq: 'weekly' }), ruleDirty: false }),
    );
  });

  it('reads a rule the person changed', () => {
    expect(formReading({ extras: {}, item: event({ freq: 'weekly' }), ruleDirty: true })).not.toBe(
      formReading({ extras: {}, item: event(), ruleDirty: false }),
    );
  });
});
