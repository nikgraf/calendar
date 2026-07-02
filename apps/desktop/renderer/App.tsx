import { BackendProvider } from '@calendar/app-state';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { backend } from './backend.ts';

const backendValue = {
  client: backend,
  onChanged: window.calendarBridge.onChanged,
};

export function App() {
  return (
    <BackendProvider value={backendValue}>
      <CalendarApp />
    </BackendProvider>
  );
}
