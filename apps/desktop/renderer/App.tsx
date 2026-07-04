import { BackendProvider, makeBackendAtoms, useBackendInvalidations } from '@calendar/app-state';
import { CONFLICT_NOTICE_KEY } from '@calendar/db/keys';
import { useEffect, useState } from 'react';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { backend, subscribeInvalidations } from './backend.ts';

const backendAtoms = makeBackendAtoms(backend);

/** Transient banner for 412 server-wins: the local edit was discarded. */
function ConflictToast() {
  const [visible, setVisible] = useState(false);
  useEffect(
    () =>
      subscribeInvalidations((keys) => {
        if (keys.includes(CONFLICT_NOTICE_KEY)) {
          setVisible(true);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!visible) {
      return;
    }
    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) {
    return null;
  }
  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg">
      An edit was overridden by a newer version from Google.
    </div>
  );
}

function Bridge() {
  useBackendInvalidations(subscribeInvalidations);
  return (
    <>
      <CalendarApp />
      <ConflictToast />
    </>
  );
}

export function App() {
  return (
    <BackendProvider atoms={backendAtoms}>
      <Bridge />
    </BackendProvider>
  );
}
