import { AccountsView } from './AccountsView.tsx';
import { EventsDebugView } from './EventsDebugView.tsx';

export function App() {
  return (
    <div className="h-screen overflow-y-auto bg-neutral-50 text-neutral-900">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-10">
        <AccountsView />
        <EventsDebugView />
      </div>
    </div>
  );
}
