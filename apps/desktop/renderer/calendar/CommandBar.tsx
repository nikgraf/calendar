import { makeFindSlots } from '@calendar/ai';
import { useQuickAddModel, type EventEditorPrefill } from '@calendar/app-state';
import { Temporal, type FreeSlot } from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopSpeech } from '../ai/desktopSpeech.ts';
import { backend } from '../backend.ts';

const slotLabel = (slot: FreeSlot): string => {
  const day = Temporal.PlainDate.from(slot.date).toLocaleString('en-US', {
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} · ${slot.startTime}–${slot.endTime}`;
};

/**
 * The ⌘K bar: natural-language quick add and find-a-time on desktop,
 * running on the bundled Foundation Models helper. The desktop sibling of
 * the iOS QuickAddBar — same parsers, same editor-prefill hand-off, same
 * honesty about unavailability.
 */
export function CommandBar({
  onClose,
  onParsed,
  timeZone,
}: {
  onClose: () => void;
  onParsed: (prefill: EventEditorPrefill) => void;
  timeZone: string;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
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
    let cancelled = false;
    void desktopLanguageModel.status().then((status) => {
      if (!cancelled) {
        setAvailable(status === 'ready');
      }
    });
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-28"
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-2xl bg-white p-4 shadow-2xl"
        onClick={(mouse) => mouse.stopPropagation()}
      >
        {available === false ? (
          <p className="text-sm text-neutral-500">
            The on-device model is unavailable — Solunivo&apos;s AI features need macOS 26 with
            Apple Intelligence enabled.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
                {(['add', 'find'] as const).map((option) => (
                  <button
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      mode === option ? 'bg-blue-600 text-white' : 'text-neutral-600'
                    }`}
                    key={option}
                    onClick={() => setMode(option)}
                    type="button"
                  >
                    {option === 'add' ? 'Add' : 'Find'}
                  </button>
                ))}
              </div>
              <input
                className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                disabled={busy}
                onChange={(input) => setPhrase(input.target.value)}
                onKeyDown={(key) => {
                  if (key.key === 'Enter') {
                    void submit();
                  }
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
                      : 'border-neutral-200 bg-white'
                  }`}
                  disabled={voice === 'preparing'}
                  onClick={() => void (voice === 'recording' ? stopRecording() : startRecording())}
                  type="button"
                >
                  {voice === 'recording' ? '■' : '🎙'}
                </button>
              ) : null}
              <button
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                disabled={busy || phrase.trim() === '' || voice === 'recording'}
                onClick={() => void submit()}
                type="button"
              >
                {busy ? '…' : mode === 'find' ? 'Find' : 'Add'}
              </button>
            </div>
            {voice === 'preparing' ? (
              <p className="mt-2 text-xs text-neutral-400">Preparing dictation…</p>
            ) : voice === 'recording' ? (
              <p className="mt-2 text-xs text-neutral-400">Listening — click ■ when finished.</p>
            ) : voice === 'transcribing' ? (
              <p className="mt-2 text-xs text-neutral-400">Transcribing…</p>
            ) : null}
            {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
            {found ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {found.slots.map((slot) => (
                  <button
                    className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-sm text-blue-700 hover:bg-blue-100"
                    key={`${slot.date}T${slot.startTime}`}
                    onClick={() => pickSlot(slot)}
                    type="button"
                  >
                    {slotLabel(slot)}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
