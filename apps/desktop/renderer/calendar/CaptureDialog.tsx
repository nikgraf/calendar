import {
  CAPTURE_MODEL_UNAVAILABLE,
  describeCaptureRow,
  useModelAvailability,
  type CaptureRow,
  type CaptureState,
} from '@calendar/app-state';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { modelUnavailableCopy } from '../ai/modelUnavailableCopy.ts';
import { Dialog } from '../Dialog.tsx';

/** Why the model could not read the paste, in the quick-add field's words. */
function ModelUnavailableReason() {
  const { status } = useModelAvailability(desktopLanguageModel);
  return modelUnavailableCopy(status).long;
}

/**
 * The review list for a capture: every event the model found in a pasted
 * email or screenshot, each a button that opens the normal editor
 * prefilled. Nothing is written from here — a row counts as added only
 * once its editor saved. The progress and error states live in the same
 * dialog so a paste always answers with something on screen.
 */
export function CaptureDialog({
  onClose,
  onOpenRow,
  state,
}: {
  onClose: () => void;
  onOpenRow: (row: CaptureRow) => void;
  state: Exclude<CaptureState, { kind: 'idle' }>;
}) {
  const added = state.kind === 'review' ? state.rows.filter((row) => row.status === 'added') : [];
  return (
    <Dialog
      align="top"
      label="Events from paste"
      onClose={onClose}
      panelClassName="w-[560px] rounded-2xl bg-surface p-4 shadow-2xl"
      zIndex={40}
    >
      <div data-capture-state={state.kind}>
        {state.kind === 'reading' || state.kind === 'extracting' ? (
          <p className="text-sm text-ink-secondary">
            {state.kind === 'reading' ? 'Reading the image…' : 'Looking for events…'}
          </p>
        ) : state.kind === 'error' ? (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-sm text-ink-secondary">
              {state.message === CAPTURE_MODEL_UNAVAILABLE ? (
                <ModelUnavailableReason />
              ) : (
                state.message
              )}
            </p>
            <button
              className="rounded-lg border border-hairline px-3 py-1.5 text-sm"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">
                {state.rows.length} {state.rows.length === 1 ? 'event' : 'events'} found
              </h2>
              <p className="text-xs text-ink-secondary">
                Open one to review it before it is added.
              </p>
            </div>
            <ul className="flex flex-col gap-1.5">
              {state.rows.map((row) => (
                <li key={row.id}>
                  <button
                    className="flex w-full items-center gap-3 rounded-lg border border-hairline px-3 py-2 text-left hover:bg-surface-subtle disabled:bg-surface-subtle disabled:text-ink-secondary"
                    data-capture-row={row.id}
                    data-status={row.status}
                    disabled={row.status === 'added'}
                    onClick={() => onOpenRow(row)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {row.prefill.title}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        {describeCaptureRow(row)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs">
                      {row.status === 'added' ? '✓ Added' : 'Open'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {state.truncated ? (
              <p className="mt-3 text-xs text-ink-secondary">
                The text was long, so only its beginning was read — later events may be missing.
              </p>
            ) : null}
            <div className="mt-3 flex justify-end">
              <button
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover"
                onClick={onClose}
                type="button"
              >
                {added.length === state.rows.length ? 'Done' : 'Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
