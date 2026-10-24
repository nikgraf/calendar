import {
  appleCalendarStatusCopy,
  contactsStatusCopy,
  remindersStatusCopy,
  useAccounts,
  useBackendMutations,
  useSetupNeeded,
  useUpdateOnboarding,
} from '@calendar/app-state';
import {
  describeImportSummary,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  isSignInCancelled,
  type SetupOutcome,
} from '@calendar/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import { ReadCodePanel } from '../settingsCode/ReadCodePanel.tsx';
import { type PendingImport, pickSettingsFile } from '../settingsTransfer.ts';
import { Button } from '../ui/Button.tsx';
import { CalendarIcon, ChevronRightIcon, CloudUpIcon } from '../ui/icons.tsx';
import { useOnboardingEnabled } from './enabled.ts';
import { onSetupRequested } from './setupRequests.ts';

const SETTINGS_PATH = 'System Settings › Privacy & Security';

/** What "What do you use?" offers; Google Calendar and Tasks share a sign-in. */
interface Sources {
  readonly appleCalendar: boolean;
  readonly googleCalendar: boolean;
  readonly googleTasks: boolean;
  readonly reminders: boolean;
}

const DEFAULT_SOURCES: Sources = {
  appleCalendar: true,
  googleCalendar: true,
  googleTasks: true,
  reminders: false,
};

type Step = 'appleCalendar' | 'copied' | 'copy' | 'google' | 'reminders' | 'sources' | 'welcome';

/** The steps after "What do you use?", one per ticked source. */
const stepsFor = (sources: Sources): ReadonlyArray<Step> => [
  'sources',
  ...(sources.googleCalendar || sources.googleTasks ? ['google' as const] : []),
  ...(sources.appleCalendar ? ['appleCalendar' as const] : []),
  ...(sources.reminders ? ['reminders' as const] : []),
];

/** Statuses macOS will not ask about again: the step says where to allow, and moves on. */
const BLOCKED = ['denied', 'restricted', 'unavailable', 'writeOnly'];

/** Asked once per permission; a change in System Settings reaches the app on its own. */
const useAppleStatus = (read: () => Promise<string>): string | null => {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void read().then((next) => {
      if (mounted) {
        setStatus(next);
      }
    });
    return () => {
      mounted = false;
    };
  }, [read]);
  return status;
};

const readCalendarStatus = () => window.calendarBridge.appleCalendarStatus();
const readRemindersStatus = () => window.calendarBridge.remindersStatus();
const readContactsStatus = () => window.calendarBridge.contactsStatus();

/**
 * The first run on the Mac: the iPhone's screens as one dialog over the
 * calendar — Welcome, "What do you use?", one step per ticked source,
 * and the copy door (a settings file for now). It opens on its own when
 * the window's first read finds nothing connected and the setup never
 * ran, or on request from the sidebar card's "Add your accounts" row;
 * Skip, Escape and the scrim leave it as skipped, the last step as done.
 * Mounted once, in the calendar window's root, beside the agent approval
 * dialog.
 */
export function SetupDialog() {
  const enabled = useOnboardingEnabled();
  const due = useSetupNeeded();
  const update = useUpdateOnboarding();
  // Where the dialog is open on, or null: once open it stays until it is
  // finished, though "nothing connected" stops being true as soon as the
  // Google step signs the first account in.
  const [open, setOpen] = useState<Step | null>(null);
  // Whether it opens on its own is decided once per window, from the
  // first read: a Skip is not met again, and the last account removed
  // later (in the Settings window) does not open it mid-session.
  const [decided, setDecided] = useState(false);
  // Opened on its own and still on Welcome, untouched. If accounts arrive
  // some other way meanwhile — the watched settings file is imported a
  // beat after launch, possibly after the first read — there is nothing
  // left to set up: it closes again, recording nothing.
  const [untouched, setUntouched] = useState(false);
  // Render-phase state adjustments (the React "derive from props" pattern).
  if (enabled === true && due !== null && !decided) {
    setDecided(true);
    if (due) {
      setOpen('welcome');
      setUntouched(true);
    }
  }
  if (untouched && due === false) {
    setUntouched(false);
    setOpen(null);
  }
  useEffect(
    () =>
      onSetupRequested(() => {
        setUntouched(false);
        setOpen('sources');
      }),
    [],
  );
  if (open === null) {
    return null;
  }
  const finish = (outcome: SetupOutcome) => {
    setUntouched(false);
    setOpen(null);
    void update({ setup: outcome });
  };
  return (
    <SetupPanel
      initialStep={open}
      key={open}
      onFinish={finish}
      onStepChange={() => setUntouched(false)}
    />
  );
}

function SetupPanel({
  initialStep,
  onFinish,
  onStepChange,
}: {
  initialStep: Step;
  onFinish: (outcome: SetupOutcome) => void;
  /** Any step taken: the dialog is no longer an untouched Welcome. */
  onStepChange: () => void;
}) {
  const [step, showStep] = useState<Step>(initialStep);
  const setStep = (to: Step) => {
    onStepChange();
    showStep(to);
  };
  const [sources, setSources] = useState<Sources>(DEFAULT_SOURCES);
  const [imported, setImported] = useState<PendingImport | null>(null);
  const steps = stepsFor(sources);
  // Ended once: an answer that comes in after Skip (macOS granting access
  // while the ask was still on screen) neither moves on nor turns the
  // skip into done.
  const ended = useRef(false);
  const end = (outcome: SetupOutcome) => {
    if (!ended.current) {
      ended.current = true;
      onFinish(outcome);
    }
  };
  const skip = () => end('skipped');
  const next = (from: Step) => {
    if (ended.current) {
      return;
    }
    const following = steps[steps.indexOf(from) + 1];
    if (following === undefined) {
      end('done');
    } else {
      setStep(following);
    }
  };
  const position = (of: Step) => ({ index: steps.indexOf(of), total: steps.length });

  return (
    <Dialog
      label="Set up Solunivo"
      onClose={skip}
      panelClassName="w-[560px] max-h-[85vh] overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
      zIndex={40}
    >
      <div data-step={step} data-testid="setup-dialog">
        {step === 'welcome' ? (
          <Welcome
            onCopy={() => setStep('copy')}
            onSkip={skip}
            onStart={() => setStep('sources')}
          />
        ) : step === 'sources' ? (
          <StepFrame
            actions={
              <Button
                data-testid="setup-continue"
                onClick={() => next('sources')}
                variant="primary"
              >
                Continue
              </Button>
            }
            lead="Tick what Solunivo should show. One short step for each, then your calendar."
            onSkip={skip}
            step={position('sources')}
            title="What do you use?"
          >
            <SourcesStep onChange={setSources} sources={sources} />
          </StepFrame>
        ) : step === 'google' ? (
          <StepFrame
            actions={
              <Button data-testid="setup-continue" onClick={() => next('google')} variant="primary">
                Continue
              </Button>
            }
            lead="Sign in to each Google account you use. They all show in one calendar."
            onSkip={skip}
            step={position('google')}
            title="Google"
          >
            <GoogleStep tasks={sources.googleTasks} />
          </StepFrame>
        ) : step === 'appleCalendar' ? (
          // Keyed: the two Apple steps are separate asks, and a refusal
          // on one must not carry over to the other.
          <AppleStep
            key="calendar"
            onNext={() => next('appleCalendar')}
            onSkip={skip}
            provider="calendar"
            step={position('appleCalendar')}
          />
        ) : step === 'reminders' ? (
          <AppleStep
            key="reminders"
            onNext={() => next('reminders')}
            onSkip={skip}
            provider="reminders"
            step={position('reminders')}
          />
        ) : step === 'copy' ? (
          <CopyStep
            onByHand={() => setStep('sources')}
            onImported={(pending) => {
              setImported(pending);
              setStep('copied');
            }}
            onSkip={skip}
          />
        ) : (
          <CopiedStep imported={imported} onFinish={() => end('done')} />
        )}
      </div>
    </Dialog>
  );
}

/** A step's shell: the dots and Skip along the top, the title and lead, the content, the actions. */
function StepFrame({
  actions,
  children,
  lead,
  onSkip,
  step,
  title,
}: {
  actions: ReactNode;
  children: ReactNode;
  lead: string;
  onSkip?: (() => void) | undefined;
  step?: { readonly index: number; readonly total: number } | undefined;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-6 items-center justify-between">
        {step ? (
          <div
            aria-label={`Step ${String(step.index + 1)} of ${String(step.total)}`}
            className="flex items-center gap-1.5"
            role="img"
          >
            {Array.from({ length: step.total }, (_, index) => (
              <span
                className={`h-1.5 rounded-full ${
                  index === step.index ? 'w-6 bg-primary' : 'w-1.5 bg-hairline-strong'
                }`}
                key={index}
              />
            ))}
          </div>
        ) : (
          <span />
        )}
        {onSkip ? (
          <Button data-testid="setup-skip" onClick={onSkip} size="sm" variant="ghost">
            Skip
          </Button>
        ) : null}
      </div>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-ink-secondary">{lead}</p>
      </div>
      {children}
      <div className="flex justify-end gap-2 pt-1">{actions}</div>
    </div>
  );
}

function Welcome({
  onCopy,
  onSkip,
  onStart,
}: {
  onCopy: () => void;
  onSkip: () => void;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col gap-5" data-testid="setup-welcome">
      <div className="flex h-6 items-center justify-end">
        <Button data-testid="setup-skip" onClick={onSkip} size="sm" variant="ghost">
          Skip
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <span className="mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-on-primary">
          <CalendarIcon size={24} />
        </span>
        <h2 className="text-2xl font-semibold tracking-tight">Welcome to Solunivo</h2>
        <p className="text-sm text-ink-secondary">
          Your Google calendars, Apple Calendar and Reminders, side by side. Everything stays on
          this Mac — there is no Solunivo server.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <button
          // The dialog's first focus: the way forward, not Skip.
          autoFocus
          className="flex items-center gap-3 rounded-xl bg-primary px-4 py-3 text-left text-on-primary hover:bg-primary-hover"
          data-testid="setup-start"
          onClick={onStart}
          type="button"
        >
          <CalendarIcon size={22} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Set up</span>
            <span className="text-sm opacity-80">
              Pick what you use, connect it, done in a minute
            </span>
          </span>
          <ChevronRightIcon size={16} />
        </button>
        <button
          className="flex items-center gap-3 rounded-xl bg-fill px-4 py-3 text-left hover:bg-hairline"
          data-testid="setup-copy"
          onClick={onCopy}
          type="button"
        >
          <CloudUpIcon size={22} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Copy from your iPhone</span>
            <span className="text-sm text-ink-secondary">
              Already using Solunivo there? Read its code and skip the setup
            </span>
          </span>
          <ChevronRightIcon className="text-ink-secondary" size={16} />
        </button>
      </div>
      <p className="text-center text-xs text-ink-secondary">
        Skip goes straight to the calendar. Everything here can be done later from Getting started.
      </p>
    </div>
  );
}

const SOURCE_ROWS: ReadonlyArray<{
  readonly key: keyof Sources;
  readonly subtitle: string;
  readonly title: string;
}> = [
  {
    key: 'googleCalendar',
    subtitle: 'Events from every Google account, in one calendar',
    title: 'Google Calendar',
  },
  {
    key: 'googleTasks',
    subtitle: 'Same sign-in as Google Calendar, one more permission',
    title: 'Google Tasks',
  },
  {
    key: 'appleCalendar',
    subtitle: 'The Calendar app’s calendars: iCloud, Exchange, subscriptions',
    title: 'Apple Calendar',
  },
  { key: 'reminders', subtitle: 'Your lists as tasks, both ways', title: 'Apple Reminders' },
];

function SourcesStep({
  onChange,
  sources,
}: {
  onChange: (sources: Sources) => void;
  sources: Sources;
}) {
  return (
    <>
      <div className="flex flex-col divide-y divide-hairline rounded-xl bg-surface-subtle">
        {SOURCE_ROWS.map((row) => (
          <label className="flex cursor-pointer items-center gap-3 px-4 py-3" key={row.key}>
            <input
              checked={sources[row.key]}
              data-testid={`setup-source-${row.key}`}
              onChange={(change) => onChange({ ...sources, [row.key]: change.target.checked })}
              type="checkbox"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{row.title}</span>
              <span className="text-xs text-ink-secondary">{row.subtitle}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-ink-secondary">
        Nothing ticked? Continue goes straight to the calendar; Getting started in the sidebar
        brings you back here.
      </p>
    </>
  );
}

/** The Google step: the accounts signed in so far, "Add another account", the waiting row. */
function GoogleStep({ tasks }: { tasks: boolean }) {
  const accounts = useAccounts();
  const google = accounts.filter((account) => account.provider === 'google');
  const mutations = useBackendMutations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      await mutations.addAccount({ tasks });
    } catch (error) {
      // Cancelled in the browser or here: nothing went wrong.
      if (!isSignInCancelled(error)) {
        setError(String(error));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-sm">
        <Point>Every account in one calendar</Point>
        {tasks ? <Point>Tasks beside your events, with due dates</Point> : null}
        <Point>Invite people by name</Point>
      </ul>
      <div className="flex flex-col divide-y divide-hairline rounded-xl bg-surface-subtle">
        {google.map((account) => (
          <div
            className="flex items-center gap-3 px-4 py-2.5"
            data-testid={`setup-account-${account.id}`}
            key={account.id}
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-event-blue text-xs font-semibold text-on-event-blue">
              {(account.displayName ?? account.email).charAt(0).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{account.email}</span>
              <span className="text-xs text-ink-secondary">
                {account.tasksEnabled ? 'Calendar and Tasks' : 'Calendar'}
              </span>
            </span>
            <span className="text-xs text-ink-secondary">Signed in</span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          {busy ? (
            <>
              <span className="text-sm text-ink-secondary" data-testid="setup-google-waiting">
                Waiting for Google in your browser…
              </span>
              <Button
                data-testid="setup-cancel-google"
                onClick={() => void window.calendarBridge.authCancel()}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button data-testid="setup-add-google" onClick={() => void addAccount()} size="sm">
              {google.length > 0 ? 'Add another account…' : 'Add a Google account…'}
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <p className="rounded-control bg-fill p-3 text-sm whitespace-pre-wrap text-danger select-text">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-ink-secondary">
        {tasks
          ? '“Add another account” opens your browser. Google asks for Calendar — and Tasks, because you ticked it. Nothing leaves this Mac except to Google.'
          : '“Add another account” opens your browser. Google asks for Calendar. Nothing leaves this Mac except to Google.'}
      </p>
    </>
  );
}

function Point({ children }: { children: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
      <span>{children}</span>
    </li>
  );
}

/**
 * The Apple Calendar and Reminders steps, one shape: a preview of what
 * arrives, three points, the note about the one-time prompt, the ask. A
 * grant moves on by itself; "Not now" moves on without one; a refusal, or
 * a Mac without the bridge, says so and leaves Continue.
 */
function AppleStep({
  onNext,
  onSkip,
  provider,
  step,
}: {
  onNext: () => void;
  onSkip: () => void;
  provider: 'calendar' | 'reminders';
  step: { readonly index: number; readonly total: number };
}) {
  const status = useAppleStatus(provider === 'calendar' ? readCalendarStatus : readRemindersStatus);
  const { connectAppleCalendar, connectReminders } = useBackendMutations();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const name = provider === 'calendar' ? 'Calendar' : 'Reminders';
  const blocked = status !== null && (BLOCKED.includes(status) || refused);
  const connect = async () => {
    setBusy(true);
    try {
      const result = await (provider === 'calendar' ? connectAppleCalendar : connectReminders)(
        undefined,
      );
      if (result.granted) {
        onNext();
      } else {
        setRefused(true);
      }
    } catch {
      setRefused(true);
    } finally {
      setBusy(false);
    }
  };
  const preview =
    provider === 'calendar'
      ? [
          { detail: 'iCloud', tint: 'bg-event-blue-edge', title: 'Home' },
          { detail: 'Exchange', tint: 'bg-event-mint-edge', title: 'Work' },
          { detail: 'Subscribed', tint: 'bg-event-blush-edge', title: 'Holidays' },
        ]
      : [
          { detail: 'Tomorrow', tint: 'bg-event-blue-edge', title: 'Olive oil' },
          { detail: '', tint: 'bg-event-blue-edge', title: 'Call the dentist' },
          { detail: 'Fri', tint: 'bg-event-blue-edge', title: 'Return the library books' },
        ];
  return (
    <StepFrame
      actions={
        blocked ? (
          <Button data-testid="setup-continue" onClick={onNext} variant="primary">
            Continue
          </Button>
        ) : (
          <>
            <Button data-testid="setup-not-now" disabled={busy} onClick={onNext} variant="ghost">
              Not now
            </Button>
            <Button
              data-testid={`setup-allow-${provider}`}
              disabled={busy || status === null}
              onClick={() => void connect()}
              variant="primary"
            >
              {busy ? 'Asking macOS…' : `Allow access to ${name}`}
            </Button>
          </>
        )
      }
      lead={
        provider === 'calendar'
          ? 'The calendars in this Mac’s Calendar app, beside your Google ones.'
          : 'Your Reminders lists as task lists, edited from either app.'
      }
      onSkip={onSkip}
      step={step}
      title={provider === 'calendar' ? 'Apple Calendar' : 'Reminders'}
    >
      <div className="flex flex-col gap-2 rounded-xl bg-surface-subtle px-4 py-3 text-sm">
        {provider === 'reminders' ? (
          <span className="text-xs font-medium text-ink-secondary">Groceries · Reminders</span>
        ) : null}
        {preview.map((row) => (
          <div className="flex items-center gap-2.5" key={row.title}>
            <span className={`size-2.5 rounded-full ${row.tint}`} />
            <span className="flex-1">{row.title}</span>
            <span className="text-xs text-ink-secondary">{row.detail}</span>
          </div>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {provider === 'calendar' ? (
          <>
            <Point>iCloud, Exchange and subscribed calendars appear as they are</Point>
            <Point>Edits here write back to the Calendar app</Point>
            <Point>Read on this Mac; nothing is copied or uploaded</Point>
          </>
        ) : (
          <>
            <Point>Each list becomes a task list</Point>
            <Point>Due dates land on the calendar</Point>
            <Point>Done here is done in Reminders, and the other way round</Point>
          </>
        )}
      </ul>
      <p className="text-xs text-ink-secondary" data-testid="setup-apple-note">
        {status === null
          ? ''
          : blocked
            ? `${name}: ${
                provider === 'calendar'
                  ? appleCalendarStatusCopy(status, SETTINGS_PATH)
                  : remindersStatusCopy(status, SETTINGS_PATH)
              }`
            : `macOS asks once. Change your mind any time in ${SETTINGS_PATH} › ${
                provider === 'calendar' ? 'Calendars' : 'Reminders'
              } — the app reconnects on its own.`}
      </p>
    </StepFrame>
  );
}

/**
 * The copy door: the iPhone's settings code, read by this Mac's camera or
 * pasted (a settings file still imports), previewed before it applies.
 */
function CopyStep({
  onByHand,
  onImported,
  onSkip,
}: {
  onByHand: () => void;
  onImported: (pending: PendingImport) => void;
  onSkip: () => void;
}) {
  const mutations = useBackendMutations();
  const [pending, setPending] = useState<PendingImport | null>(null);
  // The code behind the preview, and the last one Cancel turned down: the
  // reader comes back with the iPhone still showing it, and must not
  // reopen the same preview from the camera.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pick = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const picked = await pickSettingsFile(mutations);
      setPendingCode(null);
      setPending(picked);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    const current = pending;
    if (!current) {
      return;
    }
    setBusy(true);
    try {
      const summary = await mutations.importSettings({ document: current.document });
      onImported({ ...current, summary });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setPending(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepFrame
      actions={
        pending ? (
          <>
            <Button
              data-testid="setup-import-cancel"
              disabled={busy}
              onClick={() => {
                setDeclined(pendingCode);
                setPending(null);
              }}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              data-testid="setup-import-confirm"
              disabled={busy}
              onClick={() => void confirm()}
              variant="primary"
            >
              Copy these settings
            </Button>
          </>
        ) : (
          <>
            <Button data-testid="setup-by-hand" onClick={onByHand} variant="ghost">
              Set up by hand instead
            </Button>
            <Button data-testid="setup-import-file" disabled={busy} onClick={() => void pick()}>
              Import a settings file…
            </Button>
          </>
        )
      }
      lead="Show the code on the iPhone — Solunivo › Settings › Settings File › Show Code for Your Mac — and hold it up to this Mac’s camera, or paste it."
      onSkip={onSkip}
      title="Copy from your iPhone"
    >
      {pending ? (
        <div data-testid="setup-import-preview">
          <h3 className="text-sm font-medium">Copy {pending.source}?</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
            {describeImportSummary(pending.summary).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-secondary">Nothing is removed by an import.</p>
        </div>
      ) : (
        <>
          <ReadCodePanel
            camera
            declined={declined}
            onRead={(next, code) => {
              setPendingCode(code);
              setPending(next);
            }}
          />
          <p className="text-xs text-ink-secondary">
            What comes over: accounts as a sign-in list, which calendars and lists are shown, time
            zones, alerts and birthday reminders. Never passwords or sign-in tokens: each Google
            account signs in once here.
          </p>
        </>
      )}
      {notice ? (
        <p className="text-sm text-danger" data-testid="setup-copy-notice">
          {notice}
        </p>
      ) : null}
    </StepFrame>
  );
}

/**
 * After the copy: what the code (or file) set is listed as done; what is this
 * Mac's own stays to do — a sign-in per Google account, the Apple
 * permissions the file says were on, Contacts. "Open the calendar" ends
 * the setup with them done or not.
 */
function CopiedStep({
  imported,
  onFinish,
}: {
  imported: PendingImport | null;
  onFinish: () => void;
}) {
  const accounts = useAccounts();
  const mutations = useBackendMutations();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<string | null>(null);
  const [remindersStatus, setRemindersStatus] = useState<string | null>(null);
  const [contactsStatus, setContactsStatus] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([readCalendarStatus(), readRemindersStatus(), readContactsStatus()]).then(
      ([calendar, reminders, contacts]) => {
        if (mounted) {
          setCalendarStatus(calendar);
          setRemindersStatus(reminders);
          setContactsStatus(contacts);
        }
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  const google = accounts.filter((account) => account.provider === 'google');
  const pendingApple = (kind: 'apple-calendar' | 'apple-reminders') =>
    imported?.summary.appleAccountsPending.some((entry) => entry.kind === kind) === true;
  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (!isSignInCancelled(error)) {
        setError(String(error));
      }
    } finally {
      setBusy(null);
    }
  };
  const allowRows: Array<ReactNode> = [];
  if (pendingApple('apple-calendar') && !accounts.some(isAppleCalendarAccount)) {
    allowRows.push(
      <AllowRow
        busy={busy === 'calendar'}
        key="calendar"
        onAllow={() =>
          void run('calendar', async () => {
            await mutations.connectAppleCalendar(undefined);
            setCalendarStatus(await readCalendarStatus());
          })
        }
        subtitle={
          calendarStatus === 'notDetermined' || calendarStatus === null
            ? 'Your iPhone shows Apple calendars; matched by name here'
            : appleCalendarStatusCopy(calendarStatus, SETTINGS_PATH)
        }
        testId="setup-copied-allow-calendar"
        title="Calendar"
      />,
    );
  }
  if (pendingApple('apple-reminders') && !accounts.some(isAppleRemindersAccount)) {
    allowRows.push(
      <AllowRow
        busy={busy === 'reminders'}
        key="reminders"
        onAllow={() =>
          void run('reminders', async () => {
            await mutations.connectReminders(undefined);
            setRemindersStatus(await readRemindersStatus());
          })
        }
        subtitle={
          remindersStatus === 'notDetermined' || remindersStatus === null
            ? 'Your lists as task lists, as on the iPhone'
            : remindersStatusCopy(remindersStatus, SETTINGS_PATH)
        }
        testId="setup-copied-allow-reminders"
        title="Reminders"
      />,
    );
  }
  if (contactsStatus === 'notDetermined') {
    allowRows.push(
      <AllowRow
        busy={busy === 'contacts'}
        key="contacts"
        onAllow={() =>
          void run('contacts', async () => {
            await mutations.connectContacts(undefined);
            setContactsStatus(await readContactsStatus());
          })
        }
        subtitle={contactsStatusCopy(contactsStatus, SETTINGS_PATH)}
        testId="setup-copied-allow-contacts"
        title="Contacts"
      />,
    );
  }
  return (
    <StepFrame
      actions={
        <Button data-testid="setup-finish" onClick={onFinish} variant="primary">
          Open the calendar
        </Button>
      }
      lead="Calendars, zones and alerts are set like on your iPhone. What is left is this Mac’s own: sign in, and allow."
      title="Settings copied"
    >
      {google.length > 0 ? (
        <div className="flex flex-col divide-y divide-hairline rounded-xl bg-surface-subtle">
          {google.map((account) => {
            const pending = account.status === 'reauth_required';
            return (
              <div className="flex items-center gap-3 px-4 py-2.5" key={account.id}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{account.email}</span>
                  <span className="text-xs text-ink-secondary">
                    {pending ? 'Waits for the sign-in' : 'Signed in'}
                  </span>
                </span>
                {pending ? (
                  <Button
                    data-testid={`setup-copied-sign-in-${account.id}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run('google', () => mutations.addAccount({ loginHint: account.email }))
                    }
                    size="sm"
                    variant="primary"
                  >
                    {busy === 'google' ? 'Waiting…' : 'Sign in'}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {allowRows.length > 0 ? (
        <div className="flex flex-col divide-y divide-hairline rounded-xl bg-surface-subtle">
          {allowRows}
        </div>
      ) : null}
      {error ? (
        <p className="rounded-control bg-fill p-3 text-sm whitespace-pre-wrap text-danger select-text">
          {error}
        </p>
      ) : null}
      {imported ? (
        <div>
          <h3 className="text-xs font-semibold text-ink-secondary uppercase">Already applied</h3>
          <ul className="mt-1.5 flex flex-col gap-1 text-sm text-ink-secondary">
            {describeImportSummary(imported.summary).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </StepFrame>
  );
}

function AllowRow({
  busy,
  onAllow,
  subtitle,
  testId,
  title,
}: {
  busy: boolean;
  onAllow: () => void;
  subtitle: string;
  testId: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-ink-secondary">{subtitle}</span>
      </span>
      <Button data-testid={testId} disabled={busy} onClick={onAllow} size="sm">
        {busy ? 'Asking…' : 'Allow'}
      </Button>
    </div>
  );
}
