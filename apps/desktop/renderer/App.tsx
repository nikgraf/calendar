import {
  BackendProvider,
  makeBackendAtoms,
  type MutationNotice,
  subscribeMutationNotices,
  useBackendInvalidations,
} from '@calendar/app-state';
import { CONFLICT_NOTICE_KEY } from '@calendar/db/keys';
import { useEffect, useState } from 'react';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
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

/** Transient banner for failed fire-and-forget mutations (mutationGuard). */
function MutationNoticeToast() {
  const [notice, setNotice] = useState<MutationNotice | null>(null);
  useEffect(() => subscribeMutationNotices(setNotice), []);
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) {
    return null;
  }
  return (
    <div className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-red-700 px-4 py-2 text-sm text-white shadow-lg">
      <div>Couldn&rsquo;t {notice.action} — the change was not applied.</div>
      {notice.detail ? <div className="mt-0.5 text-xs opacity-80">{notice.detail}</div> : null}
    </div>
  );
}

function Bridge() {
  useBackendInvalidations(subscribeInvalidations);
  return (
    <>
      <CalendarApp />
      <ConflictToast />
      <MutationNoticeToast />
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <BackendProvider atoms={backendAtoms}>
        <Bridge />
      </BackendProvider>
    </ErrorBoundary>
  );
}
