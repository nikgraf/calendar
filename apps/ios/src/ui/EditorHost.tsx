import type { CaptureSource } from '@calendar/ai';
import {
  useCalendars,
  useCaptureModel,
  useTaskLists,
  useTimeZones,
  type EventEditorPrefill,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  type EventRecord,
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
import { fixtureShareFromUrl, takeIncomingShare } from '../incomingShare.ts';
import { languageModel, modelFixture, textRecognizer } from '../model.ts';
import { CaptureBanner } from './CaptureBanner.tsx';
import { CaptureSheet } from './CaptureSheet.tsx';
import { EventDetailSheet } from './EventDetailSheet.tsx';
import { EventEditSheet, type EditSeed } from './EventEditSheet.tsx';
import { QuickAddSheet } from './QuickAddSheet.tsx';

/** The share extension opens the app at `<scheme>://expo-sharing` once the payload is stored. */
const isShareUrl = (url: string) => /^[a-z-]+:\/\/expo-sharing/i.test(url);

/** What every screen can ask the host to open. */
export interface EditorHost {
  readonly closeAll: () => void;
  /** The event editor: a slot, a prefill, an existing event (`initialMode: 'task'` converts). */
  readonly editEvent: (
    seed: EditSeed,
    options?: { readonly captureRow?: string; readonly initialMode?: 'task' },
  ) => void;
  /** The task editor for an existing task, or a new one from a seed (a quick-add phrase). */
  readonly editTask: (task: TaskRecord | { readonly seed: TaskEditorSeed }) => void;
  readonly openBirthday: (birthday: BirthdayOccurrence) => void;
  /** The read-first event view; its Edit button opens the editor. */
  readonly openEvent: (event: EventRecord) => void;
  readonly openQuickAdd: () => void;
}

/**
 * One sheet at a time, in a small set of states. The quick-add sheet and
 * the detail sheet hand over to the editor by replacing themselves: two
 * sibling Modals never present together on iOS, and a sheet over a sheet
 * only happens where the capture list hosts the editor as its child.
 */
type Sheet =
  | { readonly kind: 'none' }
  | { readonly kind: 'quickAdd' }
  | { readonly event: EventRecord; readonly kind: 'detail' }
  | {
      readonly captureRow?: string | undefined;
      readonly initialMode?: 'task' | undefined;
      readonly kind: 'editEvent';
      readonly seed: EditSeed;
    }
  | {
      readonly kind: 'editTask';
      readonly prefill?: TaskEditorSeed | undefined;
      readonly task?: TaskRecord | undefined;
    }
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' };

const NONE: Sheet = { kind: 'none' };

const EditorHostContext = createContext<EditorHost | null>(null);

export const useEditorHost = (): EditorHost => {
  const host = useContext(EditorHostContext);
  if (!host) {
    throw new Error('useEditorHost outside EditorHostProvider');
  }
  return host;
};

/**
 * Owns every sheet of the app — quick add, the event detail, the editors,
 * the birthday detail, the capture review — and the capture model behind
 * the share sheet and deep links, so the Calendar and Tasks tabs open the
 * same sheets without owning them. Mounted once, under the providers.
 */
export function EditorHostProvider({ children }: { children: ReactNode }) {
  const zones = useTimeZones();
  const timeZone = zones.loaded ? zones.primary : Temporal.Now.timeZoneId();
  const [sheet, setSheet] = useState<Sheet>(NONE);
  const calendars = useCalendars();
  const taskLists = useTaskLists();

  // A parsed prefill (quick-add, or a single captured event) opens the
  // editor: the user reviews it before anything is written.
  const openPrefill = (prefill: EventEditorPrefill, captureRow?: string) =>
    setSheet({
      captureRow,
      kind: 'editEvent',
      seed: { initialDate: Temporal.PlainDate.from(prefill.date), prefill },
    });
  const capture = useCaptureModel({
    model: languageModel,
    onSingle: openPrefill,
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

  const host: EditorHost = {
    closeAll: () => setSheet(NONE),
    editEvent: (seed, options) =>
      setSheet({
        captureRow: options?.captureRow,
        initialMode: options?.initialMode,
        kind: 'editEvent',
        seed,
      }),
    editTask: (task) =>
      setSheet(
        'seed' in task ? { kind: 'editTask', prefill: task.seed } : { kind: 'editTask', task },
      ),
    openBirthday: (birthday) => setSheet({ birthday, kind: 'birthday' }),
    openEvent: (event) => setSheet({ event, kind: 'detail' }),
    openQuickAdd: () => setSheet({ kind: 'quickAdd' }),
  };
  const close = host.closeAll;

  // Keyed + conditionally mounted: a sheet seeds its form fields from its
  // seed in useState initializers, which only run on mount.
  const editSheet =
    sheet.kind === 'editEvent' ? (
      <EventEditSheet
        calendars={calendars}
        initialMode={sheet.initialMode}
        key={`event:${sheet.seed.event?.id ?? `new:${sheet.seed.initialDate.toString()}:${sheet.seed.initialTimes?.startTime ?? ''}`}`}
        onClose={close}
        onSaved={
          sheet.captureRow === undefined ? undefined : () => capture.markAdded(sheet.captureRow!)
        }
        seed={sheet.seed}
        taskLists={taskLists}
        timeZone={timeZone}
      />
    ) : sheet.kind === 'editTask' ? (
      <EventEditSheet
        calendars={calendars}
        key={`task:${sheet.task?.id ?? 'new'}`}
        onClose={close}
        seed={{
          initialDate: sheet.prefill
            ? Temporal.PlainDate.from(sheet.prefill.initialDate)
            : Temporal.Now.plainDateISO(timeZone),
        }}
        task={sheet.task}
        taskLists={taskLists}
        taskPrefill={sheet.prefill}
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
      {sheet.kind === 'quickAdd' ? (
        <QuickAddSheet
          onClose={close}
          onEditEvent={(seed) => setSheet({ kind: 'editEvent', seed })}
          onEditTask={(seed) => setSheet({ kind: 'editTask', prefill: seed })}
          timeZone={timeZone}
        />
      ) : null}
      {sheet.kind === 'detail' ? (
        <EventDetailSheet
          calendars={calendars}
          event={sheet.event}
          key={`detail:${sheet.event.calendarId}:${sheet.event.id}`}
          onClose={close}
          onConvert={() =>
            setSheet({
              initialMode: 'task',
              kind: 'editEvent',
              seed: { event: sheet.event, initialDate: Temporal.Now.plainDateISO(timeZone) },
            })
          }
          onEdit={() =>
            setSheet({
              kind: 'editEvent',
              seed: { event: sheet.event, initialDate: Temporal.Now.plainDateISO(timeZone) },
            })
          }
          timeZone={timeZone}
        />
      ) : null}
      {capture.state.kind === 'review' ? (
        <CaptureSheet
          onClose={capture.dismiss}
          onOpenRow={(row) => openPrefill(row.prefill, row.id)}
          rows={capture.state.rows}
          truncated={capture.state.truncated}
        >
          {editSheet}
        </CaptureSheet>
      ) : (
        editSheet
      )}
      <CaptureBanner onDismiss={capture.dismiss} state={capture.state} />
    </EditorHostContext.Provider>
  );
}
