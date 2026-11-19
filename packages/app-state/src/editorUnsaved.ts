import type { ItemKind } from '@calendar/core';
import { useState } from 'react';
import type { EditorMode, EditorSourceKind } from './editorSwitch.ts';
import type { QuickAddItem } from './quickAddItem.ts';

/**
 * Whether closing the editor now would lose something put into it — the
 * question before Cancel, a swipe down (iOS) or another item opened over
 * it (the Mac). The seed is not a change: a slot's times, the kind a
 * Convert editor opened on, the Create lesson's phrase. A field put back
 * as it was is none either: the form is compared with how it opened.
 */
export const editorUnsaved = ({
  assistant,
  canSave,
  drafts,
  formChanged,
  previewing,
  userEdits,
  writing,
}: {
  /** The editor's thread (`useThreadEditor`): a new item, a saved one, or none (a conversion). */
  readonly assistant: 'new' | 'none' | 'saved';
  /** Something here can be written: not a birthday, not a read-only item. */
  readonly canSave: boolean;
  /** A new item's drafts not written yet: a phrase's, a pick's, a share's. */
  readonly drafts: number;
  /** The form's reading differs from the one it opened with. */
  readonly formChanged: boolean;
  /** An older step is on show: there are steps, and the newest one decides. */
  readonly previewing: boolean;
  /** Edits made by hand, counted (the one measure a Convert editor has: its form fills as it opens). */
  readonly userEdits: number;
  /**
   * What the form shows is being written, with nothing asked first (a
   * lossy move's question is no write yet): it lands whether the editor
   * stays or not, so it is no loss. A thread's other drafts still are.
   */
  readonly writing: boolean;
}): boolean => {
  if (!canSave) {
    return false;
  }
  if (writing) {
    return assistant === 'new' && drafts > 1;
  }
  if (previewing) {
    return true;
  }
  switch (assistant) {
    case 'new':
      return drafts > 0 || formChanged;
    case 'saved':
      return formChanged;
    case 'none':
      return userEdits > 0;
  }
};

/**
 * The question before an editor holding something is closed, as Calendar
 * asks it: about the new item(s), or about the changes to a saved one.
 * Its answers are `DISCARD_ANSWERS`.
 */
export const discardQuestion = ({
  count,
  isNew,
  noun,
}: {
  /** The drafts a new item's thread holds; one for a single item. */
  readonly count: number;
  readonly isNew: boolean;
  /** What the item is; `item` for several drafts of more than one kind. */
  readonly noun: ItemKind | 'item';
}): string => {
  if (!isNew) {
    return 'Are you sure you want to discard your changes?';
  }
  return count > 1
    ? `Are you sure you want to discard these ${String(count)} new ${noun}s?`
    : `Are you sure you want to discard this new ${noun}?`;
};

/** The two answers: the destructive one, and the one that leaves the editor as it is. */
export const DISCARD_ANSWERS = { discard: 'Discard Changes', keep: 'Keep Editing' } as const;

/**
 * The editor's side of it (`useThreadEditor`): whether it holds something
 * (`editorUnsaved`), and the question to ask about it — the new item(s)
 * by kind, several drafts together as events or, mixed, items.
 */
export const editorDiscard = ({
  assistant,
  draftKinds,
  formChanged,
  kind,
  mode,
  previewing,
  readOnly,
  sourceKind,
  userEdits,
  writing,
}: {
  readonly assistant: 'new' | 'none' | 'saved';
  /** The kinds of a new item's drafts, one per draft. */
  readonly draftKinds: ReadonlyArray<'event' | 'task'>;
  /** The form reads otherwise than it opened (`useFormChanged`). */
  readonly formChanged: boolean;
  /** What the form shows now. */
  readonly kind: ItemKind;
  readonly mode: EditorMode;
  readonly previewing: boolean;
  /** Which model cannot be written, per mode. */
  readonly readOnly: { readonly event: boolean; readonly todo: boolean };
  readonly sourceKind: EditorSourceKind;
  readonly userEdits: number;
  /** What the form shows is being written, nothing asked first (`editorUnsaved`). */
  readonly writing: boolean;
}): { readonly question: string; readonly unsaved: boolean } => {
  const isNew = sourceKind === 'new';
  const several = draftKinds.length > 1;
  return {
    question: discardQuestion({
      count: isNew ? Math.max(draftKinds.length, 1) : 1,
      isNew,
      noun: several ? (draftKinds.every((draft) => draft === 'event') ? 'event' : 'item') : kind,
    }),
    unsaved: editorUnsaved({
      assistant,
      canSave: sourceKind !== 'birthday' && !readOnly[mode],
      drafts: draftKinds.length,
      formChanged,
      previewing,
      userEdits,
      writing,
    }),
  };
};

/** The form's readings as it opened, per mode: the event form, the to-do form. */
type OpenedReadings = { readonly [Mode in EditorMode]?: string };

/**
 * The form as one reading to compare (`useFormChanged`): the item and
 * what it holds beyond it. An event's rule is in it only once it is
 * another than the form was seeded with (`ruleDirty`), a rule taken away
 * as none: a series' rule that arrives after the editor opened, or
 * changes elsewhere, re-seeds the form, and is no change of the person's.
 */
export const formReading = ({
  extras,
  item,
  ruleDirty,
}: {
  readonly extras: unknown;
  readonly item: QuickAddItem;
  readonly ruleDirty: boolean;
}): string =>
  JSON.stringify({
    extras,
    item:
      item.kind === 'event'
        ? { ...item, prefill: { ...item.prefill, recurrence: undefined } }
        : item,
    rule: item.kind === 'event' && ruleDirty ? (item.prefill.recurrence ?? null) : undefined,
  });

/**
 * One step of `useFormChanged`: whether the form reads otherwise than it
 * opened, and whether to read its opening now — the first, as the editor
 * opens, and a new item's after its kind was switched while it read
 * as it opened: the other form (or the same one round again, or the other
 * list's) opens afresh, since the switch alone loses nothing. A saved item
 * switched to another kind is a conversion waiting for Save, and changed;
 * so is a new one switched after something was put in, whose other form
 * has no opening of its own.
 */
export const formChange = ({
  isNew,
  mode,
  opened,
  reading,
  switched,
  untouched,
}: {
  readonly isNew: boolean;
  readonly mode: EditorMode;
  readonly opened: OpenedReadings;
  readonly reading: string;
  /** The kind on show is another than at the last commit. */
  readonly switched: boolean;
  /** At the last commit, the form read as it opened. */
  readonly untouched: boolean;
}): { readonly changed: boolean; readonly open: boolean } => {
  const anyOpened = Object.keys(opened).length > 0;
  if (!anyOpened || (isNew && switched && untouched)) {
    return { changed: false, open: true };
  }
  const baseline = opened[mode];
  return { changed: baseline === undefined ? anyOpened : reading !== baseline, open: false };
};

/**
 * Whether the form reads otherwise than it opened (`formChange`): a field
 * put back reads as it did. The opening is read as the editor opens, a
 * saved series' too: its rule, which arrives later (`useEventMaster`) and
 * seeds itself, is not in the reading until the person changes it
 * (`formReading`), so an edit made before it lands is still a change.
 */
export const useFormChanged = ({
  isNew,
  kind,
  mode,
  reading,
}: {
  readonly isNew: boolean;
  readonly kind: ItemKind;
  readonly mode: EditorMode;
  readonly reading: string;
}): boolean => {
  const [opened, setOpened] = useState<OpenedReadings>({});
  // As last rendered: the kind on show, and whether the form read as it opened.
  const [last, setLast] = useState({ kind, untouched: true });
  const { changed, open } = formChange({
    isNew,
    mode,
    opened,
    reading,
    switched: kind !== last.kind,
    untouched: last.untouched,
  });
  // Render-phase state adjustment (React's "derive from props" pattern).
  if (open) {
    setOpened({ ...opened, [mode]: reading });
  }
  if (last.kind !== kind || last.untouched === changed) {
    setLast({ kind, untouched: !changed });
  }
  return changed;
};
