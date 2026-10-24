import type { CaptureSource } from '@calendar/ai';
import {
  defaultTodoKind,
  findNotificationEvent,
  useCalendars,
  useUpdateOnboarding,
  useCaptureModel,
  useTaskLists,
  useTimeZones,
  type EventEditorPrefill,
} from '@calendar/app-state';
import {
  availableItemKinds,
  type BirthdayOccurrence,
  eventIdentity,
  type EventRecord,
  type ItemKind,
  type NotificationTarget,
  resolveItemKind,
  type TaskFold,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { extractSettingsCode } from '@calendar/core/settingsCode';
import { router, usePathname } from 'expo-router';
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
import { fixtureShareFromUrl, settingsCodeOf, takeIncomingShare } from '../incomingShare.ts';
import { subscribeNotificationTaps } from '../notifications.ts';
import { languageModel, modelFixture, textRecognizer } from '../model.ts';
import { forceOnboarding } from '../onboarding.ts';
import { deliverSettingsCode } from '../settingsCodeInbox.ts';
import { CaptureBanner } from './CaptureBanner.tsx';
import { EventDetailSheet } from './EventDetailSheet.tsx';
import { EventEditSheet, type EditSeed } from './EventEditSheet.tsx';
import { TaskFoldSheet } from './TaskFoldSheet.tsx';
import {
  captureMayOpen,
  closeDeleted,
  closeEditor,
  type EditSheet,
  NONE,
  type Sheet,
} from './sheets.ts';

/** The share extension opens the app at `<scheme>://expo-sharing` once the payload is stored. */
const isShareUrl = (url: string) => /^[a-z-]+:\/\/expo-sharing/i.test(url);
/** The e2e flows' `<scheme>://onboarding-fixture`: the first run from the top, under the fixture model only. */
const isOnboardingFixtureUrl = (url: string) => /^[a-z-]+:\/\/onboarding-fixture/i.test(url);

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
  /**
   * The Create lesson's editor, while it is up: its opening's number
   * (each opening its own). The Getting started card shows folded for it,
   * so the draft is in view between the card and the half-height sheet.
   */
  readonly lessonEditor: number | undefined;
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
  /** A fold chip's list of today's overdue or undated tasks. */
  readonly openTaskFold: (fold: TaskFold, tasks: ReadonlyArray<TaskRecord>) => void;
  /** What the editor route shows: the open editor (kept while the sheet slides away). */
  readonly renderEditor: () => ReactNode;
}

/**
 * How long a sheet takes to slide away: UIKit presents one at a time, so
 * the editor's form sheet waits for a page sheet (detail, birthday) to
 * leave, and a page sheet for the form sheet.
 */
const PAGE_SHEET_DISMISS_MS = 450;
const FORM_SHEET_DISMISS_MS = 500;

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
 * birthday detail, a fold chip's task list — and the capture model behind the share sheet and deep
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
  const updateOnboarding = useUpdateOnboarding();

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
  // When the last page sheet (detail, birthday, a fold's list) has slid away.
  const pageSheetGone = useRef(0);
  // A route to push once the form sheet is gone (Settings, asked for from
  // behind a half-height editor); any sheet asked for meanwhile takes over.
  const afterFormSheet = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const from = previousKind.current;
    previousKind.current = sheet.kind;
    if (sheet.kind !== 'none') {
      afterFormSheet.current = undefined;
    }
    if (from === 'detail' || from === 'birthday' || from === 'fold') {
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

  // A page sheet waits until the editor's form sheet is gone: a tap on the
  // calendar behind a half-height editor opens the detail while the route
  // is still sliding away, and UIKit presents one sheet at a time. A
  // finished capture's thread waits for it too.
  const formSheetGone = routeSheet === null && !formSheetLeaving;

  // What a capture found opens the editor as one thread of drafts on the
  // first one's day, as on the desktop: each is seen in the editor before
  // anything is written; the pager steps through them, "Add all" writes
  // them. It never replaces what the user opened while it ran (an editor,
  // a detail, Settings): the thread is held until that has closed
  // (`captureMayOpen`).
  const pathname = usePathname();
  const settingsShown = pathname === '/settings' || pathname.startsWith('/settings/');
  // The first-run setup holds a capture too: a warm share leaves it up
  // (`+native-intent.tsx`), and the thread waits for it to close.
  const setupShown = pathname === '/setup' || pathname.startsWith('/setup/');
  // Settings asked for and not showing yet: the router dispatches a push a
  // commit later, and from behind an editor the push waits for its form
  // sheet. A sheet asked for meanwhile takes over, as from `afterFormSheet`.
  const [settingsAsked, setSettingsAsked] = useState(false);
  // A settings code on its way to a reader (`onSettingsCode`).
  const [codeAsked, setCodeAsked] = useState(false);
  if (settingsAsked && (settingsShown || sheet.kind !== 'none')) {
    setSettingsAsked(false);
  }
  // A sheet opened meanwhile takes over from a code's delivery, as from
  // `afterFormSheet`: nothing holds the thread for it any more.
  if (codeAsked && sheet.kind !== 'none') {
    setCodeAsked(false);
  }
  const [captured, setCaptured] = useState<EditSheet | null>(null);
  if (
    captured !== null &&
    captureMayOpen(sheet, {
      formSheetGone,
      settingsOpen: settingsShown || settingsAsked || setupShown || codeAsked,
    })
  ) {
    setCaptured(null);
    setSheet(captured);
  }
  const openThread = (prefills: ReadonlyArray<EventEditorPrefill>, note?: string) => {
    const first = prefills[0];
    if (!first) {
      return;
    }
    setCaptured({
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
  // A dismissed capture leaves nothing behind, a held thread included.
  const dismissCapture = () => {
    capture.dismiss();
    setCaptured(null);
  };

  // Something shared into the app (the share sheet, or the e2e flows' deep
  // link under the fixture model) starts a capture — over whatever sheet was
  // open, since the share is what the user is doing now. The extension
  // stores the payload and opens the app, so it is picked up on that URL and
  // again whenever the app comes to the foreground; a store read twice is
  // empty the second time. A thread still held from an earlier share gives
  // way to it.
  const startCapture = (source: CaptureSource, onSettled?: () => void) => {
    setSheet(NONE);
    setCaptured(null);
    capture.start(source, onSettled);
  };
  // A settings code from outside a reader: a share, or the Camera app's
  // "Open in Solunivo" (the code parses as a `solunivo:` URL). The inbox
  // brings up the right reader (settingsCodeInbox.ts) once the sheet that
  // was open has gone: Settings › Read Code pushed over a half-height
  // editor would be what the editor's own dismissal pops (as for
  // `openSettings`), and UIKit presents one sheet at a time. With nothing
  // open it still waits a task: a share's URL also sends the router to `/`
  // (`+native-intent.tsx`) from expo-router's own URL listener, and that
  // navigation must land before the reader's push, not pop it — whichever
  // listener runs first. Until the reader is up, a capture's thread waits
  // (`codeAsked`, then `settingsAsked`).
  const onSettingsCode = useEffectEvent((code: string) => {
    setCodeAsked(true);
    const deliver = () => {
      setCodeAsked(false);
      if (deliverSettingsCode(code, router) === '/settings/read-code') {
        setSettingsAsked(true);
      }
    };
    if (routeMounted.current) {
      afterFormSheet.current = deliver;
      setSheet(NONE);
      return;
    }
    const pageSheet = sheet.kind === 'detail' || sheet.kind === 'birthday';
    setSheet(NONE);
    setTimeout(deliver, pageSheet ? PAGE_SHEET_DISMISS_MS : 0);
  });
  // The subscriptions below are made once, but `startCapture` closes over
  // this render's model, recognizer and time zone (a share after the
  // primary zone changed must resolve "tomorrow" in the new zone), so they
  // go through an effect event, which always runs the latest render's.
  const onIncoming = useEffectEvent((source: CaptureSource, onSettled?: () => void) => {
    // A settings code (the Mac's, shared as text) is not an event to read:
    // it goes to the code reader, over whatever sheet was open.
    const code = settingsCodeOf(source);
    if (code) {
      onSettled?.();
      onSettingsCode(code);
      return;
    }
    startCapture(source, onSettled);
  });
  // The onboarding flow's deep link (fixture builds only): the stored
  // state back to a fresh install's, onboarding switched on for this
  // launch whatever the bundle says, and the setup presented — over any
  // sheet, as a share is.
  const onOnboardingFixture = useEffectEvent(() => {
    forceOnboarding();
    setSheet(NONE);
    // Guarded: a failed reset is a toast, and the setup still goes up.
    void updateOnboarding({ reset: 'all' }).then(() => router.push('/setup'));
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
      const code = url.toLowerCase().startsWith('solunivo:') ? extractSettingsCode(url) : null;
      if (code) {
        onSettingsCode(code);
        return;
      }
      if (isShareUrl(url)) {
        pickUpShare();
        return;
      }
      if (modelFixture && isOnboardingFixtureUrl(url)) {
        onOnboardingFixture();
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
  // could replace the detail when its run finished, or its held thread
  // once the detail closed. An event deleted since opens nothing and leaves
  // the capture alone.
  const onNotificationTap = useEffectEvent((target: NotificationTarget) => {
    void findNotificationEvent(backendClient, target).then((event) => {
      if (event) {
        dismissCapture();
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
    lessonEditor: routeSheet?.seed.lesson === undefined ? undefined : routeSheet.opening,
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
      if (afterFormSheet.current) {
        return;
      }
      setSettingsAsked(true);
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
    openTaskFold: (fold, tasks) => setSheet({ fold, kind: 'fold', tasks }),
    // Keyed per opening: an editor seeds its form fields (and its thread)
    // from its seed once, on mount. It closes only its own opening: a
    // write's reply can land after the sheet moved on (`closeEditor`).
    renderEditor: () =>
      routeSheet === null ? null : (
        <EventEditSheet
          calendars={calendars}
          initialKind={routeSheet.initialKind}
          key={`edit:${String(routeSheet.opening)}`}
          onClose={() => setSheet(closeEditor(routeSheet.opening))}
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

  // The birthday detail is its own page sheet, conditionally mounted.
  const birthdaySheet =
    sheet.kind === 'birthday' && formSheetGone ? (
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
      {sheet.kind === 'detail' && formSheetGone ? (
        <EventDetailSheet
          calendars={calendars}
          event={sheet.event}
          // By identity: the sheet follows its event, and a reminder tapped
          // for the occurrence it shows (edited on its own since, under a
          // new id) leaves it up.
          key={`detail:${eventIdentity(sheet.event)}`}
          onClose={close}
          onConvert={(event) =>
            setSheet({
              initialKind: defaultTodoKind(taskLists),
              kind: 'edit',
              opening: nextOpening(),
              seed: {
                event,
                initialDate: Temporal.Now.plainDateISO(timeZone),
                initialScope: 'series',
              },
            })
          }
          onDeleted={(scope) => setSheet(closeDeleted(sheet.event, scope))}
          onEdit={(event) =>
            setSheet({
              kind: 'edit',
              opening: nextOpening(),
              seed: { event, initialDate: Temporal.Now.plainDateISO(timeZone) },
            })
          }
          timeZone={timeZone}
        />
      ) : null}
      {birthdaySheet}
      {sheet.kind === 'fold' && formSheetGone ? (
        <TaskFoldSheet
          fold={sheet.fold}
          key={`fold:${sheet.fold}`}
          onClose={close}
          onEdit={host.editTask}
          tasks={sheet.tasks}
          timeZone={timeZone}
        />
      ) : null}
      <CaptureBanner onDismiss={dismissCapture} state={capture.state} />
    </EditorHostContext.Provider>
  );
}
