import type { TaskEditorSeed } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  deleteTakes,
  type EventRecord,
  type ItemKind,
  type RecurringScope,
  type TaskFold,
  type TaskRecord,
} from '@calendar/core';
import type { EditSeed } from './EventEditSheet.tsx';

/**
 * One sheet at a time, in a small set of states (`EditorHost`). The detail,
 * the birthday and a fold's task list are page sheets (React Native
 * Modals); the editor is a
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
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' }
  /** A fold chip's list: the tasks it held when tapped, drawn as they are now. */
  | { readonly fold: TaskFold; readonly kind: 'fold'; readonly tasks: ReadonlyArray<TaskRecord> };

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
 * Whether a finished capture's thread may open now: only once nothing else
 * is up. Its banner blocks nothing, so while it runs the user may open an
 * editor (whose unsaved input would go with a replaced sheet), a detail,
 * a birthday or Settings; the thread waits until that has closed, and the
 * editor's form sheet is gone too (`formSheetGone`), so its own route is
 * not pushed while the old one pops.
 */
export const captureMayOpen = (
  current: Sheet,
  { formSheetGone, settingsOpen }: { formSheetGone: boolean; settingsOpen: boolean },
): boolean => current.kind === 'none' && formSheetGone && !settingsOpen;

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
