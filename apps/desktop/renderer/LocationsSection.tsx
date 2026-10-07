import { useBackendMutations } from '@calendar/app-state';
import { useState } from 'react';

/**
 * The on-device geocode cache behind the editor map. Entries refresh on
 * their own (see locationHandlers), but a wipe is the escape hatch for a
 * place MapKit got wrong and the user wants looked up afresh.
 */
export function LocationsSection() {
  const { clearLocationCache } = useBackendMutations();
  const [state, setState] = useState<'busy' | 'cleared' | 'idle'>('idle');

  const clear = async () => {
    setState('busy');
    try {
      await clearLocationCache(undefined);
      setState('cleared');
    } catch {
      setState('idle');
    }
  };

  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Locations</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Event locations are looked up on this Mac with Apple Maps and remembered so the editor map
        opens instantly. Remembered places refresh every two weeks.
      </p>
      <button
        className="mt-3 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm hover:bg-fill disabled:opacity-50"
        disabled={state === 'busy'}
        onClick={() => void clear()}
        type="button"
      >
        Clear location cache
      </button>
      {state === 'cleared' ? (
        <p className="mt-2 text-xs text-ink-secondary" data-location-cache="cleared">
          Cleared — places are looked up again the next time an event opens.
        </p>
      ) : null}
    </section>
  );
}
