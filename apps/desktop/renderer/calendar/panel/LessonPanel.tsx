import { LessonTriedContext, useBackendMutations, useMarkLesson } from '@calendar/app-state';
import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { BirthdayRemindersSection } from '../../BirthdayRemindersSection.tsx';
import { ContactsSection } from '../../ContactsSection.tsx';
import { EventNotificationsSection } from '../../EventNotificationsSection.tsx';
import { TaskNotificationsSection } from '../../TaskNotificationsSection.tsx';
import { SettingsCodeCard } from '../../settingsCode/SettingsCodeCard.tsx';
import { exportSettingsToFile, shortPath } from '../../settingsTransfer.ts';
import { TimeZonesSection } from '../../TimeZonesSection.tsx';
import { Button } from '../../ui/Button.tsx';
import { SETTINGS_BUTTON_CLASS } from '../../ui/buttonStyles.ts';

/** The lessons the side panel frames: the settings sections, tried in place. */
export type PanelLessonId = Exclude<LessonId, 'create' | 'search'>;

/**
 * A lesson in the side panel: the frame ("Getting started · n of 6", the
 * title, one paragraph, Done) around the Settings section it teaches —
 * Alerts, Contacts, Time zones as they are in the settings window, and
 * Set up your iPhone around this Mac's settings code (the export below it). The first thing tried ticks the
 * lesson as done; leaving it without trying ticks it as skipped.
 */
export function LessonPanel({ id, onClose }: { id: PanelLessonId; onClose: () => void }) {
  const copy = lessonCopy(id, 'mac');
  const markLesson = useMarkLesson();
  const tried = useRef(false);
  const onTried = () => {
    if (!tried.current) {
      tried.current = true;
      void markLesson(id, 'done');
    }
  };
  // Done, Escape or another panel without a try: skipped.
  const leave = useEffectEvent(() => {
    if (!tried.current) {
      void markLesson(id, 'skipped');
    }
  });
  useEffect(() => () => leave(), []);
  return (
    <div
      aria-label={copy.title}
      className="flex min-h-0 flex-1 flex-col"
      data-lesson={id}
      data-testid="lesson-panel"
    >
      <div className="px-4 pt-3 pb-2">
        <p className="text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          Getting started · {lessonPosition(id)} of {LESSON_COUNT}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="lesson-title">
            {copy.title}
          </h2>
          <Button data-testid="lesson-done" onClick={onClose} size="sm" variant="primary">
            Done
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        <p className="text-sm text-ink-secondary">{copy.intro}</p>
        <LessonTriedContext value={onTried}>
          {id === 'alerts' ? (
            <>
              <EventNotificationsSection />
              <TaskNotificationsSection />
              <BirthdayRemindersSection />
            </>
          ) : id === 'contacts' ? (
            <ContactsSection />
          ) : id === 'zones' ? (
            <TimeZonesSection />
          ) : (
            <>
              <section
                className="flex flex-col gap-2 rounded-popover bg-surface-subtle p-4"
                data-testid="lesson-code"
              >
                <h3 className="font-medium">This Mac’s code</h3>
                <SettingsCodeCard onTried={onTried} qrSize={280} />
              </section>
              <ExportCard onTried={onTried} />
            </>
          )}
        </LessonTriedContext>
      </div>
    </div>
  );
}

/** The same settings as a file, for when a code will not do: Export here, AirDrop, Import there. */
function ExportCard({ onTried }: { onTried: () => void }) {
  const mutations = useBackendMutations();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const exportNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const path = await exportSettingsToFile(mutations);
      if (path !== null) {
        setNotice(`Saved to ${shortPath(path)}. AirDrop it to your iPhone and open it there.`);
        onTried();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="lesson-export">
      <h3 className="font-medium">Or as a file</h3>
      <p className="mt-1 text-sm text-ink-secondary">
        Export the settings, AirDrop the file to the iPhone, and import it there under Settings ›
        Settings File.
      </p>
      <button
        className={`${SETTINGS_BUTTON_CLASS} mt-3`}
        data-testid="lesson-export-file"
        disabled={busy}
        onClick={() => void exportNow()}
        type="button"
      >
        Export…
      </button>
      {notice ? (
        <p className="mt-2 text-xs text-ink-secondary" data-testid="lesson-export-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
