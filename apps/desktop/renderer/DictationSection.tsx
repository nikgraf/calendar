import { useSyncExternalStore } from 'react';
import { dictationLocale, languageName, noiseReduction } from './ai/dictationSettings.ts';

/**
 * Settings › Dictation: how the microphone records (Chromium's voice
 * processing, on by default) and the language dictation listens in, which
 * is the Mac's own. Both are this Mac's alone, like the iPhone's page.
 */
export function DictationSection() {
  const reduceNoise = useSyncExternalStore(noiseReduction.subscribe, noiseReduction.get);

  return (
    <>
      <section className="rounded-popover bg-surface-subtle p-4" data-testid="dictation-microphone">
        <h2 className="font-medium">Microphone</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Filters out background noise and echo while you dictate.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            aria-label="Reduce background noise"
            checked={reduceNoise}
            data-testid="reduce-background-noise"
            onChange={(change) => noiseReduction.set(change.target.checked)}
            type="checkbox"
          />
          Reduce background noise
        </label>
      </section>
      <section className="rounded-popover bg-surface-subtle p-4" data-testid="dictation-language">
        <h2 className="font-medium">Language</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Dictation listens in {languageName(dictationLocale())}, this Mac&rsquo;s language. Change
          it in System Settings › General › Language &amp; Region.
        </p>
      </section>
    </>
  );
}
