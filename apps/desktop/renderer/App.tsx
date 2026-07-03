import { BackendProvider, makeBackendAtoms, useBackendInvalidations } from '@calendar/app-state';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { backend, subscribeInvalidations } from './backend.ts';

const backendAtoms = makeBackendAtoms(backend);

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
