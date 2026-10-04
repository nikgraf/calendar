import {
  ModelUnavailableError,
  parseCapture,
  type CapturePhase,
  type CaptureResult,
  type CaptureSource,
  type LanguageModel,
  type TextRecognizer,
} from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { useRef, useState } from 'react';
import type { EventEditorPrefill } from './editorModel.ts';

/** One extracted event in the review list. */
export interface CaptureRow {
  readonly id: string;
  readonly prefill: EventEditorPrefill;
  /** `added` once the editor opened from this row saved. */
  readonly status: 'added' | 'open';
}

export type CaptureState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'extracting' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | {
      readonly kind: 'review';
      readonly rows: ReadonlyArray<CaptureRow>;
      /** The source was cut to fit the model; some events may be missing. */
      readonly truncated: boolean;
    };

/** What one capture run reports back, in order. */
export type CaptureEvent =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'phase'; readonly phase: CapturePhase }
  | {
      readonly drafts: ReadonlyArray<EventEditorPrefill>;
      readonly kind: 'review';
      readonly truncated: boolean;
    }
  | { readonly kind: 'single'; readonly prefill: EventEditorPrefill };

export const CAPTURE_MODEL_UNAVAILABLE = 'The on-device model is unavailable.';

const IDLE: CaptureState = { kind: 'idle' };

/**
 * One capture, start to finish, as events: the phases while it runs, then
 * exactly one of `single` (open the editor directly), `review` (show the
 * list) or `error`. Pure apart from the model and OCR calls, so it is the
 * part under test; the hook below only threads it into React state.
 */
export const runCapture = async (
  {
    model,
    recognizer,
    timeZone,
  }: { model: LanguageModel; recognizer: TextRecognizer; timeZone: string },
  source: CaptureSource,
  emit: (event: CaptureEvent) => void,
): Promise<void> => {
  let result: CaptureResult;
  try {
    result = await parseCapture({ model, recognizer }, source, {
      onPhase: (phase) => emit({ kind: 'phase', phase }),
      referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
      timeZone,
    });
  } catch (error) {
    emit({
      kind: 'error',
      message:
        error instanceof ModelUnavailableError
          ? CAPTURE_MODEL_UNAVAILABLE
          : "That couldn't be read — try again.",
    });
    return;
  }
  if (result.kind === 'rejected') {
    emit({ kind: 'error', message: result.reason });
    return;
  }
  const [only] = result.drafts;
  if (only && result.drafts.length === 1 && !result.truncated) {
    emit({ kind: 'single', prefill: only });
    return;
  }
  emit({ drafts: result.drafts, kind: 'review', truncated: result.truncated });
};

/** Applies a run's event to the state; `single` is the caller's, so it leaves idle. */
export const applyCaptureEvent = (event: CaptureEvent): CaptureState => {
  switch (event.kind) {
    case 'error':
      return { kind: 'error', message: event.message };
    case 'phase':
      return { kind: event.phase };
    case 'review':
      return {
        kind: 'review',
        rows: event.drafts.map((prefill, index) => ({
          id: `capture-${index}`,
          prefill,
          status: 'open',
        })),
        truncated: event.truncated,
      };
    case 'single':
      return IDLE;
  }
};

/** The second line of a row: when, and where if known — what the user checks before opening it. */
export const describeCaptureRow = ({ prefill }: CaptureRow): string => {
  const day = Temporal.PlainDate.from(prefill.date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });
  const when = prefill.isAllDay ? day : `${day} · ${prefill.startTime}–${prefill.endTime}`;
  return prefill.location ? `${when} · ${prefill.location}` : when;
};

export const markCaptureRowAdded = (state: CaptureState, id: string): CaptureState =>
  state.kind === 'review'
    ? {
        ...state,
        rows: state.rows.map((row) => (row.id === id ? { ...row, status: 'added' } : row)),
      }
    : state;

/**
 * The state behind the capture review (desktop CaptureDialog, iOS
 * CaptureSheet). A single extracted event never shows the list: it goes to
 * `onSingle`, and the caller opens its editor exactly as for quick-add.
 */
export const useCaptureModel = ({
  model,
  onSingle,
  recognizer,
  timeZone,
}: {
  readonly model: LanguageModel;
  readonly onSingle: (prefill: EventEditorPrefill) => void;
  readonly recognizer: TextRecognizer;
  readonly timeZone: string;
}) => {
  const [state, setState] = useState<CaptureState>(IDLE);
  // A dismissed or superseded run must not resurface its result later.
  const run = useRef(0);

  /**
   * `onSettled` fires once the run has ended, whatever the outcome and
   * even after a dismiss — the caller's chance to release what the source
   * referred to (iOS deletes the shared image), which must happen when the
   * model turned out unavailable just as much as after a successful read.
   */
  const start = (source: CaptureSource, onSettled?: () => void) => {
    const current = ++run.current;
    setState({ kind: source.kind === 'image' ? 'reading' : 'extracting' });
    void runCapture({ model, recognizer, timeZone }, source, (event) => {
      if (event.kind !== 'phase') {
        onSettled?.();
      }
      if (current !== run.current) {
        return;
      }
      if (event.kind === 'single') {
        onSingle(event.prefill);
      }
      setState(applyCaptureEvent(event));
    });
  };

  const markAdded = (id: string) => {
    setState((previous) => markCaptureRowAdded(previous, id));
  };

  const dismiss = () => {
    run.current += 1;
    setState(IDLE);
  };

  return { dismiss, markAdded, start, state };
};
