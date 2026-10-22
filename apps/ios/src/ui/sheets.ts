import type { TaskEditorSeed } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  deleteTakes,
  type EventRecord,
  type ItemKind,
  type RecurringScope,
  type TaskRecord,
} from '@calendar/core';
import type { EditSeed } from './EventEditSheet.tsx';

/**
 * One sheet at a time, in a small set of states (`EditorHost`). The detail
 * and the birthday are page sheets (React Native Modals); the editor is a
 * form sheet route (`app/editor.tsx`) the host pushes and pops as the
 * state says. The detail hands over to the editor by replacing itself. An
 * editor carries its opening's number: each opening mounts a fresh editor
 * (its forms and thread seed once).
 */
export interface EditSheet {
  readonly initialKind?: ItemKind | undefined;
  readonly kind: 'edit';
  readonly opening: number;
  readonly seed: EditSeed;
  readonly task?: TaskRecord | undefined;
  readonly taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
}

export type Sheet =
  | { readonly kind: 'none' }
  /** The event as it was opened; the sheet follows it from there. */
  | { readonly event: EventRecord; readonly kind: 'detail' }
  | EditSheet
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' };

export const NONE: Sheet = { kind: 'none' };

/**
 * An editor's own close — Cancel, or Save and Delete once the write's
 * reply is back — applies only while the sheet still holds its opening:
 * a reply landing after the user moved on (an event or a slot tapped
 * behind a half-height editor, another sheet opened after a swipe down)
 * leaves that sheet up.
 */
export const closeEditor =
  (opening: number) =>
  (current: Sheet): Sheet =>
    current.kind === 'edit' && current.opening === opening ? NONE : current;

/**
 * Whether a finished capture's thread may open now. It takes the place of
 * nothing, a detail or a birthday (read-only: nothing is lost), but never
 * of an open editor, whose unsaved input would go with it — the user may
 * open one while the capture runs, since its banner blocks nothing. It
 * waits until that editor's form sheet is gone (`formSheetGone`), so its
 * own route is not pushed while the old one pops.
 */
export const captureMayOpen = (current: Sheet, formSheetGone: boolean): boolean =>
  current.kind !== 'edit' && formSheetGone;

/**
 * The detail's Delete likewise, once the write answers: it closes the
 * sheet only while that shows an event the delete took (`deleteTakes`:
 * this one, or a sibling with a series' scope) — a detail, or an editor
 * that Edit or Convert opened meanwhile, since the event is gone.
 */
export const closeDeleted =
  (deleted: EventRecord, scope: RecurringScope) =>
  (current: Sheet): Sheet => {
    const shown =
      current.kind === 'detail'
        ? current.event
        : current.kind === 'edit'
          ? current.seed.event
          : undefined;
    return shown !== undefined && deleteTakes(deleted, scope, shown) ? NONE : current;
  };
