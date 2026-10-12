import type { CaptureSource } from '@calendar/ai';
import {
  defaultTodoKind,
  findNotificationEvent,
  useCalendars,
  useCaptureModel,
  useTaskLists,
  useTimeZones,
  type EventEditorPrefill,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  availableItemKinds,
  type BirthdayOccurrence,
  type EventRecord,
  type ItemKind,
  type NotificationTarget,
  resolveItemKind,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { router } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { AppState, Linking } from 'react-native';
import { backendClient } from '../backend.ts';
import { fixtureShareFromUrl, takeIncomingShare } from '../incomingShare.ts';
import { subscribeNotificationTaps } from '../notifications.ts';
import { languageModel, modelFixture, textRecognizer } from '../model.ts';
import { CaptureBanner } from './CaptureBanner.tsx';
import { EventDetailSheet } from './EventDetailSheet.tsx';
import { EventEditSheet, type EditSeed } from './EventEditSheet.tsx';

/** The share extension opens the app at `<scheme>://expo-sharing` once the payload is stored. */
const isShareUrl = (url: string) => /^[a-z-]+:\/\/expo-sharing/i.test(url);

/** What a "+" asks for: a new item on the day being viewed. */
export interface NewItemRequest {
  /** A to-do that starts without a due day (the Tasks tab's inbox add). */
  readonly dated?: boolean | undefined;
  readonly focused: Temporal.PlainDate;
  /** The kind this "+" wants; one that is not available falls back (`resolveItemKind`). */
  readonly kind: ItemKind;
  /** A to-do's list (`accountId:listId`), when the screen knows one (the Tasks tab's filter). */
  readonly listKey?: string | undefined;
}

/** What every screen can ask the host to open. */
export interface EditorHost {
  readonly closeAll: () => void;
  /** The event editor: a slot, a prefill, an existing event (a to-do `initialKind` converts). */
  readonly editEvent: (seed: EditSeed, options?: { readonly initialKind?: ItemKind }) => void;
  /** The task editor for an existing task. */
  readonly editTask: (task: TaskRecord) => void;
  /** The editor's form-sheet route went away (Cancel, Save, or a swipe down). */
  readonly onEditorDismissed: () => void;
  /** The editor's form-sheet route mounted. */
  readonly onEditorShown: () => void;
  readonly openBirthday: (birthday: BirthdayOccurrence) => void;
  /** The read-first event view; its Edit button opens the editor. */
  readonly openEvent: (event: EventRecord) => void;
  /** The editor on a new item: the quick-add field on top, the kind control, the form. */
  readonly openNew: (request: NewItemRequest) => void;
  /** Settings — after the editor, when one is up behind the calendar's avatar, has closed. */
  readonly openSettings: () => void;
  /** What the editor route shows: the open editor (kept while the sheet slides away). */
  readonly renderEditor: () => ReactNode;
}

/**
 * One sheet at a time, in a small set of states. The detail and the
 * birthday are page sheets (React Native Modals); the editor is a form
 * sheet route (`app/editor.tsx`) the host pushes and pops as the state
 * says. The detail hands over to the editor by replacing itself. An
 * editor carries its opening's number: each opening mounts a fresh editor
 * (its forms and thread seed once).
 */
interface EditSheet {
  readonly initialKind?: ItemKind | undefined;
  readonly kind: 'edit';
  readonly opening: number;
  readonly seed: EditSeed;
  readonly task?: TaskRecord | undefined;
  readonly taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
}

type Sheet =
  | { readonly kind: 'none' }
  | { readonly event: EventRecord; readonly kind: 'detail' }
  | EditSheet
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' };

/**
 * How long a sheet takes to slide away: UIKit presents one at a time, so
 * the editor's form sheet waits for a page sheet (detail, birthday) to
 * leave, and a page sheet for the form sheet.
 */
const PAGE_SHEET_DISMISS_MS = 450;
const FORM_SHEET_DISMISS_MS = 500;

const NONE: Sheet = { kind: 'none' };

let openings = 0;
const nextOpening = (): number => {
  openings += 1;
  return openings;
};

/** The utterance a capture's thread starts with, as the desktop's paste does. */
const FROM_SHARE = 'From your share';
const TRUNCATED_NOTE =
  'The text was long, so only its beginning was read — later events may be missing.';

const EditorHostContext = createContext<EditorHost | null>(null);

export const useEditorHost = (): EditorHost => {
  const host = useContext(EditorHostContext);
  if (!host) {
    throw new Error('useEditorHost outside EditorHostProvider');
  }
  return host;
};

/**
 * Owns every sheet of the app — the event detail, the editor (with the
 * quick-add field and the draft thread on top of a new item), the
 * birthday detail — and the capture model behind the share sheet and deep
 * links, whose events open the editor as one thread of drafts, so the
 * Calendar and Tasks tabs open the same sheets without owning them.
 * Mounted once, under the providers.
 */
export function EditorHostProvider({ children }: { children: ReactNode }) {
  const zones = useTimeZones();
  const timeZone = zones.loaded ? zones.primary : Temporal.Now.timeZoneId();
  const [sheet, setSheet] = useState<Sheet>(NONE);
  const calendars = useCalendars();
  const taskLists = useTaskLists();

  // The editor route follows the state: pushed when an editor opens (half
  // height for a new item, full for an existing one), popped when the
  // state leaves the editor. The route renders `routeSheet`, which stays
  // until the route is gone, so the sheet slides away with its content. A
  // new editor while the route is up (a slot drawn behind a half sheet)
  // only swaps the content.
  const [routeSheet, setRouteSheet] = useState<EditSheet | null>(null);
  // Render-phase state adjustment (React's "derive from props" pattern):
  // the route shows the editor the state names, and keeps it after.
  if (sheet.kind === 'edit' && routeSheet !== sheet) {
    setRouteSheet(sheet);
  }
  const presented = useRef(false);
  const previousKind = useRef<Sheet['kind']>('none');
  // When the last page sheet (detail, birthday) has slid away.
  const pageSheetGone = useRef(0);
  useEffect(() => {
    const from = previousKind.current;
    previousKind.current = sheet.kind;
    if (from === 'detail' || from === 'birthday') {
      pageSheetGone.current = Date.now() + PAGE_SHEET_DISMISS_MS;
    }
    if (sheet.kind !== 'edit') {
      if (presented.current) {
        presented.current = false;
        router.back();
      }
      return;
    }
    if (presented.current) {
      return;
    }
    presented.current = true;
    const opened = sheet;
    const detent = opened.seed.event || opened.task ? 'full' : 'half';
    const push = () => router.push({ params: { detent }, pathname: '/editor' });
    const wait = pageSheetGone.current - Date.now();
    if (wait <= 0) {
      push();
      return;
    }
    let pushed = false;
    const timer = setTimeout(() => {
      pushed = true;
      push();
    }, wait);
    // The state moved on before the push: nothing was presented, and no
    // route will unmount to say so. After it, the route is up and the
    // next run pops it.
    return () => {
      if (!pushed) {
        clearTimeout(timer);
        presented.current = false;
        setRouteSheet((current) => (current === opened ? null : current));
      }
    };
  }, [sheet]);
  // The route unmounts as its sheet starts to slide away; a page sheet
  // opened meanwhile (a tap on an event behind a half-height editor) waits
  // until it is gone.
  const [formSheetLeaving, setFormSheetLeaving] = useState(false);
  const formSheetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(formSheetTimer.current), []);
  // A route to push once the form sheet is gone (Settings, asked for from
  // behind a half-height editor).
  const afterFormSheet = useRef<(() => void) | undefined>(undefined);
  const routeMounted = useRef(false);
  const onEditorShown = useCallback(() => {
    routeMounted.current = true;
  }, []);
  // Cancel, Save or a swipe down: the route went away, and the editor with it.
  const onEditorDismissed = useCallback(() => {
    routeMounted.current = false;
    presented.current = false;
    setRouteSheet(null);
    setSheet((current) => (current.kind === 'edit' ? NONE : current));
    setFormSheetLeaving(true);
    clearTimeout(formSheetTimer.current);
    formSheetTimer.current = setTimeout(() => {
      setFormSheetLeaving(false);
      const next = afterFormSheet.current;
      afterFormSheet.current = undefined;
      next?.();
    }, FORM_SHEET_DISMISS_MS);
  }, []);

  // What a capture found opens the editor as one thread of drafts on the
  // first one's day, as on the desktop: each is seen in the editor before
  // anything is written; the pager steps through them, "Add all" writes
  // them.
  const openThread = (prefills: ReadonlyArray<EventEditorPrefill>, note?: string) => {
    const first = prefills[0];
    if (!first) {
      return;
    }
    setSheet({
      kind: 'edit',
      opening: nextOpening(),
      seed: {
        initialDate: Temporal.PlainDate.from(first.date),
        thread: {
          items: prefills.map((prefill) => ({ kind: 'event', prefill })),
          ...(note ? { note } : {}),
          utterance: FROM_SHARE,
        },
      },
    });
  };
  const capture = useCaptureModel({
    model: languageModel,
    onMany: (prefills, truncated) => openThread(prefills, truncated ? TRUNCATED_NOTE : undefined),
    onSingle: (prefill) => openThread([prefill]),
    recognizer: textRecognizer,
    timeZone,
  });

  // Something shared into the app (the share sheet, or the e2e flows' deep
  // link under the fixture model) starts a capture — over whatever sheet was
  // open, since the share is what the user is doing now. The extension
  // stores the payload and opens the app, so it is picked up on that URL and
  // again whenever the app comes to the foreground; a store read twice is
  // empty the second time.
  const startCapture = (source: CaptureSource, onSettled?: () => void) => {
    setSheet(NONE);
    capture.start(source, onSettled);
  };
  // The subscriptions below are made once, but `startCapture` closes over
  // this render's model, recognizer and time zone (a share after the
  // primary zone changed must resolve "tomorrow" in the new zone), so they
  // go through an effect event, which always runs the latest render's.
  const onIncoming = useEffectEvent((source: CaptureSource, onSettled?: () => void) => {
    startCapture(source, onSettled);
  });
  useEffect(() => {
    const pickUpShare = () => {
      const share = takeIncomingShare();
      if (share) {
        onIncoming(share.source, share.discard);
      }
    };
    const onUrl = (url: string | null) => {
      if (!url) {
        return;
      }
      if (isShareUrl(url)) {
        pickUpShare();
        return;
      }
      const fixtureSource = modelFixture ? fixtureShareFromUrl(url) : undefined;
      if (fixtureSource) {
        onIncoming(fixtureSource);
      }
    };
    pickUpShare();
    void Linking.getInitialURL().then(onUrl);
    const urlSubscription = Linking.addEventListener('url', ({ url }) => onUrl(url));
    const stateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        pickUpShare();
      }
    });
    return () => {
      urlSubscription.remove();
      stateSubscription.remove();
    };
  }, []);

  // A tapped event reminder opens that occurrence's detail, over any tab
  // and in place of whatever sheet was open — a capture's review included,
  // which would otherwise stay up beside it (two sheets cannot present) and
  // could replace the detail when its run finished. An event deleted since
  // opens nothing and leaves the capture alone.
  const onNotificationTap = useEffectEvent((target: NotificationTarget) => {
    void findNotificationEvent(backendClient, target).then((event) => {
      if (event) {
        capture.dismiss();
        setSheet({ event, kind: 'detail' });
      }
    });
  });
  useEffect(() => subscribeNotificationTaps((target) => onNotificationTap(target)), []);

  const host: EditorHost = {
    closeAll: () => setSheet(NONE),
    editEvent: (seed, options) =>
      setSheet({
        initialKind: options?.initialKind,
        kind: 'edit',
        opening: nextOpening(),
        seed,
      }),
    editTask: (task) =>
      setSheet({
        kind: 'edit',
        opening: nextOpening(),
        seed: { initialDate: Temporal.Now.plainDateISO(timeZone) },
        task,
      }),
    onEditorDismissed,
    onEditorShown,
    openBirthday: (birthday) => setSheet({ birthday, kind: 'birthday' }),
    openEvent: (event) => setSheet({ event, kind: 'detail' }),
    openNew: ({ dated, focused, kind, listKey }) => {
      // The calendar's "+" wants an event, the Tasks tab's a reminder and
      // then a task; what is not here falls back to what is.
      const resolved = resolveItemKind(kind, availableItemKinds({ calendars, taskLists }));
      setSheet({
        initialKind: resolved,
        kind: 'edit',
        opening: nextOpening(),
        seed: { initialDate: focused },
        taskSeed: resolved === 'event' ? undefined : { dated, listKey },
      });
    },
    // Settings is a route of its own: pushed over a half-height editor it
    // would stack on the sheet, and the editor's pop would take Settings
    // instead. The avatar closes the editor first — Cancel, as a tap on an
    // event behind it is — and Settings opens once the sheet has gone.
    openSettings: () => {
      if (routeMounted.current) {
        afterFormSheet.current = () => router.push('/settings');
        setSheet(NONE);
        return;
      }
      if (sheet.kind === 'edit') {
        setSheet(NONE);
      }
      router.push('/settings');
    },
    // Keyed per opening: an editor seeds its form fields (and its thread)
    // from its seed once, on mount.
    renderEditor: () =>
      routeSheet === null ? null : (
        <EventEditSheet
          calendars={calendars}
          initialKind={routeSheet.initialKind}
          key={`edit:${String(routeSheet.opening)}`}
          onClose={() => setSheet(NONE)}
          presentation="route"
          seed={routeSheet.seed}
          task={routeSheet.task}
          taskLists={taskLists}
          taskSeed={routeSheet.taskSeed}
          timeZone={timeZone}
        />
      ),
  };
  const close = host.closeAll;

  // A page sheet waits until the editor's form sheet is gone: a tap on the
  // calendar behind a half-height editor opens the detail while the route
  // is still sliding away, and UIKit presents one sheet at a time.
  const pageSheetFree = routeSheet === null && !formSheetLeaving;
  // The birthday detail is its own page sheet, conditionally mounted.
  const birthdaySheet =
    sheet.kind === 'birthday' && pageSheetFree ? (
      <EventEditSheet
        birthday={sheet.birthday}
        calendars={calendars}
        key={`birthday:${sheet.birthday.record.id}:${sheet.birthday.date}`}
        onClose={close}
        seed={{ initialDate: Temporal.PlainDate.from(sheet.birthday.date) }}
        taskLists={taskLists}
        timeZone={timeZone}
      />
    ) : null;

  return (
    <EditorHostContext.Provider value={host}>
      {children}
      {sheet.kind === 'detail' && pageSheetFree ? (
        <EventDetailSheet
          calendars={calendars}
          event={sheet.event}
          key={`detail:${sheet.event.calendarId}:${sheet.event.id}`}
          onClose={close}
          onConvert={() =>
            setSheet({
              initialKind: defaultTodoKind(taskLists),
              kind: 'edit',
              opening: nextOpening(),
              seed: {
                event: sheet.event,
                initialDate: Temporal.Now.plainDateISO(timeZone),
                initialScope: 'series',
              },
            })
          }
          onEdit={() =>
            setSheet({
              kind: 'edit',
              opening: nextOpening(),
              seed: { event: sheet.event, initialDate: Temporal.Now.plainDateISO(timeZone) },
            })
          }
          timeZone={timeZone}
        />
      ) : null}
      {birthdaySheet}
      <CaptureBanner onDismiss={capture.dismiss} state={capture.state} />
    </EditorHostContext.Provider>
  );
}
