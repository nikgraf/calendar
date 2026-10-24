import { describeImportSummary } from '@calendar/core';
import type { PendingImport } from '../settingsTransfer.ts';

/**
 * What an import would change, before it does: the lines both apps word
 * the same way, the promise that nothing is removed, Cancel and Import.
 * Shared by the file import and the code readers in Settings and the
 * calendar window.
 */
export function ImportPreview({
  busy = false,
  onCancel,
  onConfirm,
  pending,
  testId,
}: {
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  pending: PendingImport;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="font-medium">Import {pending.source}?</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
        {describeImportSummary(pending.summary).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-secondary">Nothing is removed by an import.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1.5 text-sm text-ink-secondary hover:bg-fill"
          data-testid={`${testId}-cancel`}
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          aria-label="Import settings"
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          data-testid={`${testId}-confirm`}
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          Import
        </button>
      </div>
    </div>
  );
}
