import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import { makeFindSlots, type CaptureSource } from '@calendar/ai';
import {
  useModelAvailability,
  useQuickAddModel,
  type EventEditorPrefill,
} from '@calendar/app-state';
import { formatSlotLabel, type Temporal } from '@calendar/core';
import { useEffect, useRef } from 'react';
import { Dialog } from '../Dialog.tsx';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopSpeech } from '../ai/desktopSpeech.ts';
import { backend } from '../backend.ts';
import { captureSourceOf, isCapturableInPhrase, readPaste } from './captureClipboard.ts';

/**
 * The ⌘K bar: natural-language quick add and find-a-time on desktop,
 * running on the bundled Foundation Models helper. The desktop sibling of
 * the iOS QuickAddBar — same parsers, same editor-prefill hand-off, same
 * honesty about unavailability.
 */
/** Re-check the model when the window regains focus (Apple Intelligence is switched on in System Settings). */
const onWindowFocus = (onActive: () => void): (() => void) => {
  window.addEventListener('focus', onActive);
  return () => window.removeEventListener('focus', onActive);
};

export function CommandBar({
  focusedDate,
  onCapture,
  onClose,
  onParsed,
  timeZone,
}: {
  /** Undated phrases land on the day being viewed, like the iOS bar. */
  focusedDate: Temporal.PlainDate;
  /** A pasted email or image is not a phrase: it goes to capture, and the bar closes. */
  onCapture: (source: CaptureSource) => void;
  onClose: () => void;
  onParsed: (prefill: EventEditorPrefill) => void;
  timeZone: string;
}) {
  const { checking, retry, status } = useModelAvailability(desktopLanguageModel, onWindowFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const findSlotsRef = useRef(makeFindSlots(desktopLanguageModel, backend, timeZone));
  const {
    busy,
    error,
    found,
    mode,
    phrase,
    pickSlot,
    setMode,
    setPhrase,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    fallbackDate: focusedDate.toString(),
    findSlots: (phrase) => findSlotsRef.current(phrase),
    model: desktopLanguageModel,
    // The bar is transient on desktop: hand the prefill over and close.
    onPrefill: (prefill) => {
      onParsed(prefill);
      onClose();
    },
    speech: desktopSpeech,
    timeZone,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [status]);

  return (
    <Dialog
      align="top"
      label="Quick add"
      onClose={onClose}
      panelClassName="w-[560px] rounded-2xl bg-surface p-4 shadow-2xl"
      zIndex={40}
    >
      <>
        {status !== null && status !== 'ready' ? (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-sm text-ink-secondary">
              The on-device model is unavailable — Solunivo&apos;s AI features need macOS 26 with
              Apple Intelligence enabled.
            </p>
            <button
              className="rounded-lg border border-hairline px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={checking}
              onClick={retry}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <SegmentedControl
                label="Mode"
                onChange={setMode}
                options={[
                  { label: 'Add', value: 'add' },
                  { label: 'Find', value: 'find' },
                ]}
                size="sm"
                value={mode}
              />
              <input
                className="flex-1 rounded-lg border border-hairline px-3 py-2 text-sm"
                disabled={busy}
                onChange={(input) => setPhrase(input.target.value)}
                onKeyDown={(key) => {
                  if (key.key === 'Enter') {
                    void submit();
                  }
                }}
                onPaste={(event) => {
                  const pasted = readPaste(event.clipboardData);
                  if (mode !== 'add' || !isCapturableInPhrase(pasted)) {
                    return;
                  }
                  event.preventDefault();
                  void captureSourceOf(pasted).then((source) => {
                    if (source) {
                      onCapture(source);
                    }
                  });
                  onClose();
                }}
                placeholder={
                  mode === 'find'
                    ? '90 min focus this week, mornings'
                    : 'Lunch with Sarah tomorrow at 1'
                }
                ref={inputRef}
                value={phrase}
              />
              {voiceAvailable && !busy && voice !== 'transcribing' ? (
                <button
                  aria-label={voice === 'recording' ? 'Stop dictating' : 'Dictate'}
                  className={`rounded-lg border px-2 py-1.5 text-sm ${
                    voice === 'recording'
                      ? 'border-red-500 bg-red-50'
                      : 'border-hairline bg-surface'
                  }`}
                  disabled={voice === 'preparing'}
                  onClick={() => void (voice === 'recording' ? stopRecording() : startRecording())}
                  type="button"
                >
                  {voice === 'recording' ? '■' : '🎙'}
                </button>
              ) : null}
              <button
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
                disabled={busy || phrase.trim() === '' || voice === 'recording'}
                onClick={() => void submit()}
                type="button"
              >
                {busy ? '…' : mode === 'find' ? 'Find' : 'Add'}
              </button>
            </div>
            {voice === 'preparing' ? (
              <p className="mt-2 text-xs text-ink-secondary">Preparing dictation…</p>
            ) : voice === 'recording' ? (
              <p className="mt-2 text-xs text-ink-secondary">Listening — click ■ when finished.</p>
            ) : voice === 'transcribing' ? (
              <p className="mt-2 text-xs text-ink-secondary">Transcribing…</p>
            ) : mode === 'add' && !error && !busy ? (
              <p className="mt-2 text-xs text-ink-secondary">
                Paste an email or a screenshot (here or on the calendar) to pull its events out.
              </p>
            ) : null}
            {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
            {found ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {found.slots.map((slot) => (
                  <button
                    className="rounded-lg border border-hairline-strong bg-selection px-2.5 py-1.5 text-sm text-on-selection hover:bg-selection"
                    key={`${slot.date}T${slot.startTime}`}
                    onClick={() => pickSlot(slot)}
                    type="button"
                  >
                    {formatSlotLabel(slot)}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </>
    </Dialog>
  );
}
