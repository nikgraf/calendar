import type { ItemKind } from '@calendar/core';
import { useState } from 'react';
import type { EditorMode, EditorSourceKind } from './editorSwitch.ts';

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
}): boolean => {
  if (!canSave) {
    return false;
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
  /**
   * A Save or "Add all" is under way: it lands whether the editor stays
   * or not (another chip opened meanwhile keeps its own editor), so
   * leaving loses nothing.
   */
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
      canSave: sourceKind !== 'birthday' && !readOnly[mode] && !writing,
      drafts: draftKinds.length,
      formChanged,
      previewing,
      userEdits,
    }),
  };
};

/** The form's readings as it opened, per kind: the event form, the to-do form. */
type OpenedReadings = { readonly [Mode in EditorMode]?: string };

/**
 * One step of `useFormChanged`: whether the form reads otherwise than it
 * opened, and whether to take the reading now as an opening — the first,
 * once the form is settled, and the kind a new item was switched to while
 * it held nothing, whose form then opens afresh: the switch alone loses
 * nothing. A saved item switched to another kind is a conversion waiting
 * for Save, and changed.
 */
export const formChange = ({
  isNew,
  mode,
  opened,
  reading,
  settled,
  untouched,
}: {
  readonly isNew: boolean;
  readonly mode: EditorMode;
  readonly opened: OpenedReadings;
  readonly reading: string;
  /** The form holds all the item opened with (a saved series waits for its rule). */
  readonly settled: boolean;
  /** At the last commit, the form read as it opened. */
  readonly untouched: boolean;
}): { readonly changed: boolean; readonly open: boolean } => {
  const baseline = opened[mode];
  if (baseline !== undefined) {
    return { changed: reading !== baseline, open: false };
  }
  const anyOpened = Object.keys(opened).length > 0;
  const open = settled && (!anyOpened || (isNew && untouched));
  return { changed: anyOpened && !open, open };
};

/**
 * Whether the form reads otherwise than it opened (`formChange`), from one
 * reading of it — a field put back reads as it did. A new item's opening
 * is its seed, read at once; a saved one's is read once it is `settled`.
 */
export const useFormChanged = ({
  isNew,
  mode,
  reading,
  settled,
}: {
  readonly isNew: boolean;
  readonly mode: EditorMode;
  readonly reading: string;
  readonly settled: boolean;
}): boolean => {
  const [opened, setOpened] = useState<OpenedReadings>(() => (settled ? { [mode]: reading } : {}));
  // Whether the form read as it opened, as last rendered.
  const [untouched, setUntouched] = useState(true);
  const { changed, open } = formChange({ isNew, mode, opened, reading, settled, untouched });
  // Render-phase state adjustment (React's "derive from props" pattern).
  if (open) {
    setOpened({ ...opened, [mode]: reading });
  }
  if (untouched === changed) {
    setUntouched(!changed);
  }
  return changed;
};
