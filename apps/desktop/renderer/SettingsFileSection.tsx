import { useBackendMutations } from '@calendar/app-state';
import {
  describeImportSummary,
  formatSettingsDocument,
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsImportSummary,
} from '@calendar/core';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { SettingsFileStatus } from './backend.ts';
import { Dialog } from './Dialog.tsx';

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~');

const timeLabel = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const BUTTON =
  'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50';

/** Runs one action at a time and keeps its outcome (or failure) as a line of text. */
const useAction = () => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (task: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await task());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, notice, run };
};

/**
 * One-off Export/Import of the settings document: a copy to carry to
 * another device, nothing watched. Files are a window concern (dialogs go
 * through the preload bridge); the document itself only travels over the
 * rpc seam, decoded here before it goes.
 */
export function SettingsTransferSection() {
  const mutations = useBackendMutations();
  const { busy, notice, run } = useAction();
  const [pending, setPending] = useState<{
    document: SettingsDocument;
    path: string;
    summary: SettingsImportSummary;
  } | null>(null);

  const exportToFile = () =>
    run(async () => {
      const document = await mutations.exportSettings(undefined);
      const result = await window.calendarBridge.settingsFileSave(formatSettingsDocument(document));
      return 'canceled' in result ? null : `Saved to ${shortPath(result.path)}.`;
    });

  const importFromFile = () =>
    run(async () => {
      const opened = await window.calendarBridge.settingsFileOpen();
      if ('canceled' in opened) {
        return null;
      }
      const document = await Effect.runPromise(
        parseSettingsDocument(opened.text).pipe(
          Effect.mapError((error) => new Error(`${shortPath(opened.path)}: ${error.message}`)),
        ),
      );
      const summary = await mutations.previewSettingsImport({ document });
      setPending({ document, path: opened.path, summary });
      return null;
    });

  const confirmImport = () => {
    const current = pending;
    if (!current) {
      return;
    }
    setPending(null);
    void run(async () => {
      const summary = await mutations.importSettings({ document: current.document });
      return `Imported ${shortPath(current.path)}. ${describeImportSummary(summary).join(' ')}`;
    });
  };

  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="settings-transfer"
    >
      <h2 className="font-medium">Export & import</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Save these settings as a file to carry them to another Mac or iPhone, or load a file from
        another device. A one-off copy: nothing is kept in sync. It never contains passwords or
        tokens; a Google account from another device shows up as “Sign in”.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={BUTTON}
          data-testid="settings-file-export"
          disabled={busy}
          onClick={() => void exportToFile()}
          type="button"
        >
          Export…
        </button>
        <button
          className={BUTTON}
          data-testid="settings-file-import"
          disabled={busy}
          onClick={() => void importFromFile()}
          type="button"
        >
          Import…
        </button>
      </div>
      {notice ? (
        <p className="mt-2 text-xs text-neutral-600" data-testid="settings-transfer-notice">
          {notice}
        </p>
      ) : null}
      {pending ? (
        <Dialog
          label="Import settings"
          onClose={() => setPending(null)}
          panelClassName="w-[28rem] rounded-2xl bg-white p-5 shadow-xl"
          zIndex={40}
        >
          <div data-testid="settings-import-preview">
            <h3 className="font-medium">Import {shortPath(pending.path)}?</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-700">
              {describeImportSummary(pending.summary).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500">Nothing is removed by an import.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
                onClick={() => setPending(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                aria-label="Import settings"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
                onClick={confirmImport}
                type="button"
              >
                Import
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * The watched settings file (`~/.solunivo/solunivo.jsonc`): what it is,
 * what it is good for, what it exposes, its current state, and the one
 * button that creates it. Opt-in on purpose — the file lists account
 * emails and calendar names in plain text, so it only exists once asked
 * for (or once the user put one there).
 */
export function SettingsFileSection() {
  const [status, setStatus] = useState<SettingsFileStatus | null>(null);
  const { busy, notice, run } = useAction();

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.settingsFileStatus().then((current) => {
      if (mounted) {
        setStatus(current);
      }
    });
    const unsubscribe = window.calendarBridge.onSettingsFileChanged(setStatus);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const createFile = () =>
    run(async () => {
      setStatus(await window.calendarBridge.settingsFileCreate());
      return null;
    });

  const path = status ? shortPath(status.path) : '~/.solunivo/solunivo.jsonc';

  const statusLine = (): string => {
    if (!status) {
      return '';
    }
    if (status.error) {
      return `Not applied — ${status.error}`;
    }
    if (!status.exists) {
      return `No file yet at ${path}.`;
    }
    const applied =
      status.lastAppliedAt === undefined ? '' : ` · applied ${timeLabel(status.lastAppliedAt)}`;
    return `Watching ${path}${applied}`;
  };

  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="settings-file"
    >
      <h2 className="font-medium">Settings file</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Solunivo can keep its settings in a file at <span className="select-text">{path}</span>.
        While the file exists, the app applies it whenever it changes and writes changes made here
        back to it. Comments in the file are kept.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-500">
        <li>
          Set up a new Mac: put the file in place, for example from your dotfiles, and the app
          configures itself on launch. Each Google account then needs one sign-in.
        </li>
        <li>
          Let scripts and coding agents change your settings by editing a file instead of clicking
          through this window.
        </li>
      </ul>
      <p
        className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
        data-testid="settings-file-exposure"
      >
        The file holds your settings in plain text, including the email addresses of your connected
        accounts and the names of your calendars and lists. Anything that can read your home folder
        can read it. Passwords and sign-in tokens are never written to it.
      </p>
      <p
        className={`mt-3 text-xs ${status?.error ? 'text-amber-600' : 'text-neutral-500'}`}
        data-testid="settings-file-status"
      >
        {statusLine()}
      </p>
      {status && !status.exists ? (
        <button
          className={`${BUTTON} mt-2`}
          data-testid="settings-file-create"
          disabled={busy}
          onClick={() => void createFile()}
          type="button"
        >
          Create settings file
        </button>
      ) : null}
      {notice ? (
        <p className="mt-2 text-xs text-neutral-600" data-testid="settings-file-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
