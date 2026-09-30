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

/**
 * Export/Import of the settings document, and the watched file
 * `~/.solunivo/solunivo.jsonc`. Files are a window concern (dialogs go
 * through the preload bridge); the document itself only travels over the
 * rpc seam, decoded here before it goes.
 */
export function SettingsFileSection() {
  const mutations = useBackendMutations();
  const [status, setStatus] = useState<SettingsFileStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    document: SettingsDocument;
    path: string;
    summary: SettingsImportSummary;
  } | null>(null);

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

  const createFile = () =>
    run(async () => {
      setStatus(await window.calendarBridge.settingsFileCreate());
      return null;
    });

  const statusLine = (): string => {
    if (!status) {
      return '';
    }
    if (status.error) {
      return `Not applied — ${status.error}`;
    }
    if (!status.exists) {
      return `No file yet at ${shortPath(status.path)}.`;
    }
    const applied =
      status.lastAppliedAt === undefined ? '' : ` · applied ${timeLabel(status.lastAppliedAt)}`;
    return `Watching ${shortPath(status.path)}${applied}`;
  };

  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="settings-file"
    >
      <h2 className="font-medium">Settings file</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Carry these settings to another Mac or iPhone as a file. It never contains passwords or
        tokens; a Google account from another device shows up as “Sign in again”.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
          data-testid="settings-file-export"
          disabled={busy}
          onClick={() => void exportToFile()}
          type="button"
        >
          Export…
        </button>
        <button
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
          data-testid="settings-file-import"
          disabled={busy}
          onClick={() => void importFromFile()}
          type="button"
        >
          Import…
        </button>
        {status && !status.exists ? (
          <button
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
            data-testid="settings-file-create"
            disabled={busy}
            onClick={() => void createFile()}
            type="button"
          >
            Create file
          </button>
        ) : null}
      </div>
      <p
        className={`mt-2 text-xs ${status?.error ? 'text-amber-600' : 'text-neutral-500'}`}
        data-testid="settings-file-status"
      >
        {statusLine()}
      </p>
      <p className="mt-1 text-xs text-neutral-400">
        The file is applied whenever it changes, and updated when settings change here. Comments in
        it are kept.
      </p>
      {notice ? (
        <p className="mt-2 text-xs text-neutral-600" data-testid="settings-file-notice">
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
