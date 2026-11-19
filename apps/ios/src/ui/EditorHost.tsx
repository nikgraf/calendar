import type { CaptureSource } from '@calendar/ai';
import {
  defaultTodoKind,
  findNotificationEvent,
  findNotificationTask,
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
import { showAssistantAbsent } from '../assistantRuntime.ts';
import { backendClient } from '../backend.ts';
import { fixtureShareFromUrl, settingsCodeOf, takeIncomingShare } from '../incomingShare.ts';
import { launchUrl } from '../launchUrl.ts';
import { subscribeNotificationTaps } from '../notifications.ts';
import { languageModel, modelFixture, textRecognizer } from '../model.ts';
import { forceOnboarding } from '../onboarding.ts';
import { deliverSettingsCode } from '../settingsCodeInbox.ts';
import { CaptureBanner } from './CaptureBanner.tsx';
import { EventDetailSheet } from './EventDetailSheet.tsx';
import { EventEditSheet, type EditSeed } from './EventEditSheet.tsx';
import { RouteFade } from './RouteFade.tsx';
import { TaskFoldSheet } from './TaskFoldSheet.tsx';
import {
  cancelEditor,
  captureMayOpen,
  closeDeleted,
  closeEditor,
  type EditSheet,
  inRoute,
  NONE,
  routeDismissed,
  type RouteSheet,
  routeKey,
  routeMove,
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
  /** The editor's route went away (Close, Cancel, Save, or a swipe down). */
  readonly onEditorDismissed: () => void;
  /** The editor's route mounted. */
  readonly onEditorShown: () => void;
  readonly openBirthday: (birthday: BirthdayOccurrence) => void;
  /** The read-first event view; its Edit button turns it into the editor. */
  readonly openEvent: (event: EventRecord) => void;
  /** The editor on a new item: an event on the Assistant, a to-do on its form. */
  readonly openNew: (request: NewItemRequest) => void;
  /** Settings — after the editor, when one is up behind the calendar's avatar, has closed. */
  readonly openSettings: () => void;
  /** A fold chip's list of today's overdue or undated tasks. */
  readonly openTaskFold: (fold: TaskFold, tasks: ReadonlyArray<TaskRecord>) => void;
  /** What the editor route shows: the detail or the editor (kept while the sheet slides away). */
  readonly renderRoute: () => ReactNode;
}

/**
 * How long a sheet takes to slide away: UIKit presents one at a time, so
 * the editor route's sheet waits for a page sheet (birthday, a fold's
 * list) or its own previous one to leave, and a page sheet for the
 * route's.
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
 * Owns every sheet of the app — the event detail and the editor (its
 * Assistant and its form), which share the editor route's sheet, the
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

  // The editor route follows the state: pushed when a detail or an editor
  // opens, popped when the state leaves both. The route renders
  // `routeSheet`, which stays until the route is gone, so the sheet slides
  // away with its content. A detail or an editor while the route is up only
  // swaps the content (`RouteFade`): Edit turns the detail into its editor
  // in the same sheet.
  const [routeSheet, setRouteSheet] = useState<RouteSheet | null>(null);
  // Render-phase state adjustment (React's "derive from props" pattern):
  // the route shows what the state names, and keeps it after.
  if (inRoute(sheet) && routeSheet !== sheet) {
    setRouteSheet(sheet);
  }
  const presented = useRef(false);
  const previousSheet = useRef<Sheet>(NONE);
  // When the last page sheet (birthday, a fold's list) has slid away.
  const pageSheetGone = useRef(0);
  // A route to push once the editor's sheet is gone (Settings, asked for
  // while it is up); any sheet asked for meanwhile takes over.
  const afterFormSheet = useRef<(() => void) | undefined>(undefined);
  // The route unmounts as its sheet starts to slide away, and the sheet
  // takes a while more to go: a page sheet opened meanwhile (a
  // notification's event, one tapped right after Cancel) waits until it
  // is gone, and so does the route's next push.
  const [formSheetLeaving, setFormSheetLeaving] = useState(false);
  const formSheetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(formSheetTimer.current), []);
  const routeMounted = useRef(false);
  // The host popped the route and it has not unmounted yet: its dismissal
  // is the host's own, not a swipe down.
  const popping = useRef(false);
  useEffect(() => {
    const from = previousSheet.current;
    if (from !== sheet) {
      previousSheet.current = sheet;
      if (sheet.kind !== 'none') {
        afterFormSheet.current = undefined;
      }
      if (from.kind === 'birthday' || from.kind === 'fold') {
        pageSheetGone.current = Date.now() + PAGE_SHEET_DISMISS_MS;
      }
    }
    const move = routeMove(sheet, {
      leaving: popping.current || formSheetLeaving,
      presented: presented.current,
    });
    if (move === 'pop') {
      presented.current = false;
      // A mounted route says when it has gone; one popped before it
      // mounted never will.
      popping.current = routeMounted.current;
      router.back();
      return;
    }
    if (move === 'wait') {
      // This runs again once the old sheet has gone (`formSheetLeaving`).
      // The state moving on first (a fold's chip, a share, Settings): the
      // route shows nothing it asked for, so `formSheetGone` can come
      // true. A run for the same sheet restores it (render phase above).
      const waiting = sheet;
      return () => setRouteSheet((current) => (current === waiting ? null : current));
    }
    if (move !== 'push') {
      return;
    }
    presented.current = true;
    const opened = sheet;
    const push = () => router.push('/editor');
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
  }, [formSheetLeaving, sheet]);
  const onEditorShown = useCallback(() => {
    routeMounted.current = true;
  }, []);
  // Close, Cancel, Save or a swipe down: the route went away, and the
  // detail or editor with it.
  const onEditorDismissed = useCallback(() => {
    const swiped = !popping.current;
    popping.current = false;
    routeMounted.current = false;
    presented.current = false;
    setRouteSheet(null);
    setSheet(routeDismissed(swiped));
    setFormSheetLeaving(true);
    clearTimeout(formSheetTimer.current);
    formSheetTimer.current = setTimeout(() => {
      setFormSheetLeaving(false);
      const next = afterFormSheet.current;
      afterFormSheet.current = undefined;
      next?.();
    }, FORM_SHEET_DISMISS_MS);
  }, []);

  // A page sheet waits until the route's sheet is gone: a birthday asked
  // for as the editor closes would be presented while the route is still
  // sliding away, and UIKit presents one sheet at a time. A finished
  // capture's thread waits for it too.
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
      opensOn: 'assistant',
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
  // was open has gone: Settings › Read Code pushed over the editor would
  // be what the editor's own dismissal pops (as for
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
    const pageSheet = sheet.kind === 'birthday' || sheet.kind === 'fold';
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
  const onOnboardingFixture = useEffectEvent((url: string) => {
    forceOnboarding();
    // `?assistant=absent`: as on a device without the Assistant's model yet,
    // so the Create lesson runs its demo (flow 28).
    if (/[?&]assistant=absent\b/i.test(url)) {
      showAssistantAbsent();
    }
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
    const onUrl = (url: string | null | undefined) => {
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
        onOnboardingFixture(url);
        return;
      }
      const fixtureSource = modelFixture ? fixtureShareFromUrl(url) : undefined;
      if (fixtureSource) {
        onIncoming(fixtureSource);
      }
    };
    pickUpShare();
    void launchUrl().then(onUrl);
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
  const editTask = (task: TaskRecord) =>
    setSheet({
      kind: 'edit',
      opening: nextOpening(),
      seed: { initialDate: Temporal.Now.plainDateISO(timeZone) },
      task,
    });
  const onNotificationTap = useEffectEvent((target: NotificationTarget) => {
    if (target.kind === 'task') {
      // A task reminder opens the task's editor, checked off or not; one deleted since opens nothing.
      void findNotificationTask(backendClient, target).then((task) => {
        if (task) {
          dismissCapture();
          editTask(task);
        }
      });
      return;
    }
    void findNotificationEvent(backendClient, target).then((event) => {
      if (event) {
        dismissCapture();
        setSheet({ event, kind: 'detail' });
      }
    });
  });
  useEffect(() => subscribeNotificationTaps((target) => onNotificationTap(target)), []);

  // The detail turns into its editor in place (Edit, Convert), and the
  // editor's Cancel turns it back (`backTo`); Save and Delete close the
  // sheet. Keyed by `routeKey` (`RouteFade`): the detail by its event's
  // identity, so it follows its event, and a reminder tapped for the
  // occurrence it shows (edited on its own since, under a new id) leaves
  // it up; an editor per opening, since it seeds its form fields (and its
  // thread) from its seed once, on mount. An editor closes only its own
  // opening: a write's reply can land after the sheet moved on
  // (`closeEditor`).
  const routeBody = (shown: RouteSheet) => {
    if (shown.kind === 'detail') {
      return (
        <EventDetailSheet
          calendars={calendars}
          event={shown.event}
          // Only itself: it stays mounted while the route slides away, and
          // its event going then must not close a sheet asked for since.
          onClose={() => setSheet((current) => (current === shown ? NONE : current))}
          onConvert={(event, scope) =>
            setSheet({
              backTo: event,
              initialKind: defaultTodoKind(taskLists),
              kind: 'edit',
              opening: nextOpening(),
              seed: {
                event,
                initialDate: Temporal.Now.plainDateISO(timeZone),
                initialScope: scope,
              },
            })
          }
          onDeleted={(scope) => setSheet(closeDeleted(shown.event, scope))}
          onEdit={(event) =>
            setSheet({
              backTo: event,
              kind: 'edit',
              opening: nextOpening(),
              seed: { event, initialDate: Temporal.Now.plainDateISO(timeZone) },
            })
          }
          timeZone={timeZone}
        />
      );
    }
    return (
      <EventEditSheet
        calendars={calendars}
        initialKind={shown.initialKind}
        onCancel={() => setSheet(cancelEditor(shown.opening))}
        onClose={() => setSheet(closeEditor(shown.opening))}
        // Its swipe guard holds only while the sheet names this opening:
        // the host's own close (Save, Delete, a share) goes through.
        open={sheet.kind === 'edit' && sheet.opening === shown.opening}
        opensOn={shown.opensOn}
        presentation="route"
        seed={shown.seed}
        task={shown.task}
        taskLists={taskLists}
        taskSeed={shown.taskSeed}
        timeZone={timeZone}
      />
    );
  };

  const host: EditorHost = {
    closeAll: () => setSheet(NONE),
    editEvent: (seed, options) =>
      setSheet({
        initialKind: options?.initialKind,
        kind: 'edit',
        opening: nextOpening(),
        // The Create lesson is the Assistant's; a slot drawn by hand, or an event, opens on its form.
        opensOn: seed.lesson === undefined ? undefined : 'assistant',
        seed,
      }),
    editTask,
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
        // The calendar's "+" opens on the Assistant; a to-do's, on its form: a title is all it needs.
        opensOn: resolved === 'event' ? 'assistant' : undefined,
        seed: { initialDate: focused },
        taskSeed: resolved === 'event' ? undefined : { dated, listKey },
      });
    },
    // Settings is a route of its own: pushed over the editor it would
    // stack on the sheet, and the editor's pop would take Settings
    // instead. So the editor closes first — Cancel — and Settings opens
    // once the sheet has gone.
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
      if (inRoute(sheet)) {
        setSheet(NONE);
      }
      router.push('/settings');
    },
    openTaskFold: (fold, tasks) => setSheet({ fold, kind: 'fold', tasks }),
    renderRoute: () =>
      routeSheet === null ? null : (
        <RouteFade item={routeSheet} keyOf={routeKey} render={routeBody} />
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
