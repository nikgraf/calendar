import {
  CAPTURE_MODEL_UNAVAILABLE,
  useModelAvailability,
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
 * What a paste shows while it is being read, and what it says when it
 * could not be: the progress and error states of a capture. The events
 * it finds go to the editor as drafts of one thread (CalendarApp), where
 * each is seen on the grid before anything is written, so there is no
 * list to review here any more.
 */
export function CaptureDialog({
  onClose,
  state,
}: {
  onClose: () => void;
  state: Exclude<CaptureState, { kind: 'idle' } | { kind: 'review' }>;
}) {
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
        ) : (
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
        )}
      </div>
    </Dialog>
  );
}
