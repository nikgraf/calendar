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
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
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
  readonly openBirthday: (birthday: BirthdayOccurrence) => void;
  /** The read-first event view; its Edit button opens the editor. */
  readonly openEvent: (event: EventRecord) => void;
  /** The editor on a new item: the quick-add field on top, the kind control, the form. */
  readonly openNew: (request: NewItemRequest) => void;
}

/**
 * One sheet at a time, in a small set of states. The detail sheet hands
 * over to the editor by replacing itself: two sibling Modals never
 * present together on iOS. An editor carries its opening's number: each
 * opening mounts a fresh editor (its forms and thread seed once).
 */
type Sheet =
  | { readonly kind: 'none' }
  | { readonly event: EventRecord; readonly kind: 'detail' }
  | {
      readonly initialKind?: ItemKind | undefined;
      readonly kind: 'edit';
      readonly opening: number;
      readonly seed: EditSeed;
      readonly task?: TaskRecord | undefined;
      readonly taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
    }
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' };

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
  };
  const close = host.closeAll;

  // Keyed per opening + conditionally mounted: a sheet seeds its form
  // fields (and its thread) from its seed once, on mount.
  const editSheet =
    sheet.kind === 'edit' ? (
      <EventEditSheet
        calendars={calendars}
        initialKind={sheet.initialKind}
        key={`edit:${String(sheet.opening)}`}
        onClose={close}
        seed={sheet.seed}
        task={sheet.task}
        taskLists={taskLists}
        taskSeed={sheet.taskSeed}
        timeZone={timeZone}
      />
    ) : sheet.kind === 'birthday' ? (
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
      {sheet.kind === 'detail' ? (
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
      {editSheet}
      <CaptureBanner onDismiss={capture.dismiss} state={capture.state} />
    </EditorHostContext.Provider>
  );
}
