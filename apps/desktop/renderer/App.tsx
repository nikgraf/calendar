import { BackendProvider, makeBackendAtoms, useBackendInvalidations } from '@calendar/app-state';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { backend } from './backend.ts';

const backendAtoms = makeBackendAtoms(backend);

const subscribeInvalidations = (listener: (keys: ReadonlyArray<unknown>) => void) =>
  window.calendarBridge.onInvalidated?.(listener) ?? (() => {});

function Bridge() {
  useBackendInvalidations(subscribeInvalidations);
  return <CalendarApp />;
}

export function App() {
  return (
    <BackendProvider atoms={backendAtoms}>
      <Bridge />
    </BackendProvider>
  );
}
