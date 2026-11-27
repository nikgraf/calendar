import { sessionCountLabel, sessionLogCopy } from '@calendar/ai';
import { useAction } from '@calendar/app-state';
import { useId, useState } from 'react';
import { useSessionsState } from './ai/assistantSessions.ts';
import { shortPath } from './settingsTransfer.ts';
import { Button } from './ui/Button.tsx';
import { SETTINGS_BUTTON_CLASS, TEXT_ACTION_CLASS } from './ui/buttonStyles.ts';

/**
 * Settings › AI Model › Assistant Sessions: Keep Assistant Sessions (off
 * unless switched on), how many are kept, Export… (a save dialog) and
 * Delete All, asked first. The log is main's (electron/assistantSessions.ts).
 */
export function AssistantSessionsSection() {
  const sessions = useSessionsState();
  const exporting = useAction<string | null>();
  const deleting = useAction();
  const [asking, setAsking] = useState(false);
  const id = useId();
  const count = sessions?.count ?? 0;

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="assistant-sessions">
      <h2 className="font-medium">Assistant Sessions</h2>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          checked={sessions?.on === true}
          data-testid="keep-assistant-sessions"
          disabled={sessions === undefined}
          onChange={(change) => void window.calendarBridge.sessionsSetOn(change.target.checked)}
          type="checkbox"
        />
        Keep Assistant Sessions
      </label>
      <p className="mt-1 ml-6 text-xs text-ink-secondary">{sessionLogCopy('Mac')}</p>
      <div className="mt-3 flex items-center gap-3">
        <button
          className={SETTINGS_BUTTON_CLASS}
          data-testid="assistant-sessions-export"
          disabled={count === 0 || exporting.busy}
          onClick={() =>
            void exporting.run(async () => {
              const result = await window.calendarBridge.sessionsExport();
              return 'canceled' in result ? null : result.path;
            })
          }
          type="button"
        >
          Export…
        </button>
        <button
          className={`text-sm ${TEXT_ACTION_CLASS.danger}`}
          data-testid="assistant-sessions-delete"
          disabled={count === 0 || deleting.busy}
          onClick={() => setAsking(true)}
          type="button"
        >
          Delete All
        </button>
        <span className="text-xs text-ink-secondary" data-testid="assistant-sessions-count">
          {sessionCountLabel(count)}
        </span>
      </div>
      {asking ? (
        <div
          aria-describedby={`${id}-detail`}
          aria-labelledby={`${id}-title`}
          className="mt-2 rounded-control border border-hairline bg-fill p-2 text-sm"
          data-testid="assistant-sessions-confirm"
          role="alertdialog"
        >
          <p className="font-medium" id={`${id}-title`}>
            Delete all Assistant sessions?
          </p>
          <p className="mt-0.5 text-xs text-ink-secondary" id={`${id}-detail`}>
            {`The ${sessionCountLabel(count).replace(' kept', '')} kept on this Mac go. A file you exported stays where you saved it.`}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button autoFocus onClick={() => setAsking(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              data-testid="assistant-sessions-delete-yes"
              disabled={deleting.busy}
              onClick={() =>
                void deleting.run(async () => {
                  await window.calendarBridge.sessionsDelete();
                  setAsking(false);
                })
              }
              size="sm"
              variant="danger"
            >
              Delete All
            </Button>
          </div>
        </div>
      ) : null}
      {exporting.state.kind === 'done' && exporting.state.value !== null ? (
        <p className="mt-2 text-xs text-ink-secondary" data-testid="assistant-sessions-notice">
          {`Saved to ${shortPath(exporting.state.value)}.`}
        </p>
      ) : null}
      {(exporting.error ?? deleting.error) ? (
        <p className="mt-2 text-xs text-danger">{exporting.error ?? deleting.error}</p>
      ) : null}
    </section>
  );
}
