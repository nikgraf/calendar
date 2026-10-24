import { useBackendMutations } from '@calendar/app-state';
import { describeImportSummary } from '@calendar/core';
import { useEffect, useEffectEvent, useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import { type PendingImport, readSettingsCode } from '../settingsTransfer.ts';
import { onCodeImportRequested } from './codeImportRequests.ts';
import { ImportPreview } from './ImportPreview.tsx';
import { ReadCodePanel } from './ReadCodePanel.tsx';

/** A code read before the dialog opened (a paste): its preview, or why it would not read. */
export type ReadOutcome = { readonly error: string } | { readonly pending: PendingImport };

/**
 * A settings code read and imported in one dialog: the reader (camera and
 * paste) or a code read already, the preview, then what was applied.
 * Cancel closes it from any step — a camera still pointed at the code
 * would only read it again.
 */
export function CodeImportDialog({
  camera,
  initial,
  onClose,
}: {
  camera: boolean;
  initial?: ReadOutcome | undefined;
  onClose: () => void;
}) {
  const mutations = useBackendMutations();
  const [pending, setPending] = useState<PendingImport | null>(
    initial && 'pending' in initial ? initial.pending : null,
  );
  const [applied, setApplied] = useState<ReadonlyArray<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    initial && 'error' in initial ? initial.error : null,
  );

  const confirm = async () => {
    const current = pending;
    if (!current) {
      return;
    }
    setBusy(true);
    try {
      const summary = await mutations.importSettings({ document: current.document });
      setApplied(describeImportSummary(summary));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <Dialog
      label="Copy settings from a code"
      onClose={onClose}
      panelClassName="w-[30rem] rounded-2xl bg-surface p-5 shadow-xl"
      zIndex={40}
    >
      {applied ? (
        <div data-testid="code-import-done">
          <h3 className="font-medium">Settings copied</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
            {applied.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-secondary">
            A Google account from the code waits for a sign-in under Settings › Accounts.
          </p>
          <div className="mt-4 flex justify-end">
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover"
              onClick={onClose}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      ) : pending ? (
        <ImportPreview
          busy={busy}
          onCancel={onClose}
          onConfirm={() => void confirm()}
          pending={pending}
          testId="code-import-preview"
        />
      ) : (
        <div>
          <h3 className="font-medium">Copy from a code</h3>
          <p className="mt-1 text-sm text-ink-secondary">
            On the iPhone, open Solunivo › Settings › Settings File › Show Code for Your Mac.
          </p>
          <div className="mt-3">
            <ReadCodePanel camera={camera} onRead={setPending} />
          </div>
          {notice ? (
            <p className="mt-2 text-sm text-danger" data-testid="code-import-notice">
              {notice}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <button
              className="rounded-lg px-3 py-1.5 text-sm text-ink-secondary hover:bg-fill"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * The calendar window's import dialog for a pasted code (⌘V on the grid
 * or in ⌘K): the code is read as the request arrives, and the dialog opens
 * on its preview — or on why it would not read, with the paste field to
 * try again. A new paste replaces the open one. The camera stays off: the
 * code is already here.
 */
export function CodeImportHost() {
  const mutations = useBackendMutations();
  const [request, setRequest] = useState<{ id: number; outcome: ReadOutcome } | null>(null);
  const open = useEffectEvent(async (code: string) => {
    let outcome: ReadOutcome;
    try {
      outcome = { pending: await readSettingsCode(mutations, code) };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    setRequest((last) => ({ id: (last?.id ?? 0) + 1, outcome }));
  });
  useEffect(() => onCodeImportRequested((code) => void open(code)), []);
  if (!request) {
    return null;
  }
  return (
    <CodeImportDialog
      camera={false}
      initial={request.outcome}
      key={request.id}
      onClose={() => setRequest(null)}
    />
  );
}
