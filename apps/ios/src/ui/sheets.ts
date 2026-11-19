import type { TaskEditorSeed } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  calendarTaskKey,
  deleteTakes,
  eventIdentity,
  type EventRecord,
  type ItemKind,
  type RecurringScope,
  type TaskFold,
  type TaskRecord,
} from '@calendar/core';
import type { EditSeed } from './EventEditSheet.tsx';

/**
 * One sheet at a time, in a small set of states (`EditorHost`). The
 * detail and the editor share one sheet, the route `app/editor.tsx` the
 * host pushes and pops as the state says: Edit and Convert turn the
 * detail into the editor in place, and the editor's Cancel turns it back.
 * The birthday and a fold's task list are page sheets of their own (React
 * Native Modals). An editor carries its opening's number: each opening
 * mounts a fresh editor (its forms and thread seed once).
 */
export interface EditSheet {
  /**
   * The detail that Edit or Convert turned into this editor: Cancel shows
   * it again (`cancelEditor`). Save and Delete close the sheet.
   */
  readonly backTo?: DetailSheet | TaskDetailSheet | undefined;
  readonly initialKind?: ItemKind | undefined;
  readonly kind: 'edit';
  readonly opening: number;
  /** The view to start on, where the editor has two: the Assistant for the calendar's "+", a share and the Create lesson. */
  readonly opensOn?: 'assistant' | undefined;
  readonly seed: EditSeed;
  readonly task?: TaskRecord | undefined;
  readonly taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
}

/** The event as it was opened; the sheet follows it from there. */
interface DetailSheet {
  readonly event: EventRecord;
  readonly kind: 'detail';
}

interface TaskDetailSheet {
  readonly kind: 'task-detail';
  readonly task: TaskRecord;
}

/** What the editor's route shows: the detail or the editor. */
export type RouteSheet = DetailSheet | TaskDetailSheet | EditSheet;

export type Sheet =
  | { readonly kind: 'none' }
  | RouteSheet
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' }
  /** A fold chip's list: the tasks it held when tapped, drawn as they are now. */
  | { readonly fold: TaskFold; readonly kind: 'fold'; readonly tasks: ReadonlyArray<TaskRecord> };

export const NONE: Sheet = { kind: 'none' };

/** Whether the sheet is the editor route's: going from one such sheet to another swaps the route's content, the route stays up. */
export const inRoute = (sheet: Sheet): sheet is RouteSheet =>
  sheet.kind === 'detail' || sheet.kind === 'task-detail' || sheet.kind === 'edit';

/**
 * What the editor route does for the sheet the state names (the host's
 * effect): `push` it up, `pop` it, `wait` while the route's previous sheet
 * is still leaving — UIKit presents one sheet at a time, and a push during
 * the pop would put up a sheet whose state the old route's dismissal then
 * clears — or `stay` as it is.
 */
export const routeMove = (
  sheet: Sheet,
  { leaving, presented }: { leaving: boolean; presented: boolean },
): 'pop' | 'push' | 'stay' | 'wait' => {
  if (!inRoute(sheet)) {
    return presented ? 'pop' : 'stay';
  }
  if (presented) {
    return 'stay';
  }
  return leaving ? 'wait' : 'push';
};

/**
 * The route went away. A swipe down closes the detail or editor it
 * showed. After the host's own pop the state had moved on already, and a
 * detail or editor asked for since (a tapped reminder's event) stays, to
 * go up once the old sheet has gone (`routeMove`).
 */
export const routeDismissed =
  (swiped: boolean) =>
  (current: Sheet): Sheet =>
    swiped && inRoute(current) ? NONE : current;

/**
 * What the route's content is keyed by: a new key mounts it afresh and
 * cross-fades from the old. A detail is keyed by its event's identity, so
 * a refreshed row of the event it shows (a sync pass, a tapped reminder
 * for an occurrence edited since under a new id) keeps it as it is; an
 * editor by its opening.
 */
export const routeKey = (sheet: RouteSheet): string =>
  sheet.kind === 'detail'
    ? `detail:${eventIdentity(sheet.event)}`
    : sheet.kind === 'task-detail'
      ? `task-detail:${calendarTaskKey(sheet.task)}`
      : `edit:${String(sheet.opening)}`;

/**
 * An editor's own close — Cancel, or Save and Delete once the write's
 * reply is back — applies only while the sheet still holds its opening:
 * a reply landing after the user moved on (another sheet opened after a
 * swipe down, a notification's event) leaves that sheet up.
 */
export const closeEditor =
  (opening: number) =>
  (current: Sheet): Sheet =>
    current.kind === 'edit' && current.opening === opening ? NONE : current;

/**
 * The editor's Cancel: back to the detail it was opened from (`backTo`),
 * in the same sheet, or closed when it came from anywhere else — only
 * while the sheet still holds its opening, as `closeEditor`.
 */
export const cancelEditor =
  (opening: number) =>
  (current: Sheet): Sheet => {
    if (current.kind !== 'edit' || current.opening !== opening) {
      return current;
    }
    return current.backTo ?? NONE;
  };

/** Completion closes its own detail. Deletion also takes an editor on the removed task. */
export const closeTaskDetail =
  (task: TaskRecord, action: 'complete' | 'delete', opened: TaskDetailSheet) =>
  (current: Sheet): Sheet => {
    if (current === opened) {
      return NONE;
    }
    if (action === 'complete') {
      return current;
    }
    const shown =
      current.kind === 'task-detail' || current.kind === 'edit' ? current.task : undefined;
    return shown !== undefined && calendarTaskKey(shown) === calendarTaskKey(task) ? NONE : current;
  };

/**
 * Whether a finished capture's thread may open now: only once nothing else
 * is up. Its banner blocks nothing, so while it runs the user may open an
 * editor (whose unsaved input would go with a replaced sheet), a detail,
 * a birthday or Settings; the thread waits until that has closed, and the
 * route's sheet is gone too (`formSheetGone`), so its own route is not
 * pushed while the old one pops.
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
