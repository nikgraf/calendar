import { BackendProvider, makeBackendAtoms, useBackendInvalidations } from '@calendar/app-state';
import { AgentApprovalDialog } from './agents/AgentApprovalDialog.tsx';
import { CaptureHint } from './CaptureHint.tsx';
import { CalendarApp } from './calendar/CalendarApp.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { NoticeStack } from './NoticeStack.tsx';
import { SetupDialog } from './onboarding/SetupDialog.tsx';
import { SettingsWindow } from './SettingsWindow.tsx';
import { backend, subscribeInvalidations } from './backend.ts';

const backendAtoms = makeBackendAtoms(backend);

/**
 * The calendar window's root. Its notices (toasts and the conflict banner)
 * live in the calendar's grid column — see NoticeStack. The first run's
 * setup dialog sits over the calendar here, like the agent approval. Both
 * windows show the capture hint: either can be the one left out of a
 * screenshot.
 */
function Bridge() {
  useBackendInvalidations(subscribeInvalidations);
  return (
    <>
      <CalendarApp />
      <SetupDialog />
      <AgentApprovalDialog />
      <CaptureHint />
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

/**
 * The settings window's root. It is its own rpc client with its own atoms,
 * kept current by the same invalidation stream. The calendar's overlays
 * stay in the main window — above all the agent approval dialog, which
 * must exist exactly once; Settings shows only its own failed writes.
 */
function SettingsBridge() {
  useBackendInvalidations(subscribeInvalidations);
  return (
    <>
      <SettingsWindow />
      <NoticeStack placement="window" />
      <CaptureHint />
    </>
  );
}

export function SettingsApp() {
  return (
    <ErrorBoundary>
      <BackendProvider atoms={backendAtoms}>
        <SettingsBridge />
      </BackendProvider>
    </ErrorBoundary>
  );
}
