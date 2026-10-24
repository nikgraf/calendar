import { useState } from 'react';
import { TEXT_ACTION_CLASS } from './buttonStyles.ts';

/**
 * A line of text the user copies (an agent token, a config snippet, a
 * settings code). The text stays selectable, so copying by hand works where
 * the clipboard refuses — and e2e specs read it from the `<pre>`, since
 * `writeText` rejects in an unfocused window.
 */
export function Copyable({
  label,
  onCopied,
  testId,
  text,
}: {
  label: string;
  onCopied?: (() => void) | undefined;
  testId: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The text is selectable: copying by hand still works.
    }
  };
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-secondary">{label}</span>
        <button className={`text-xs ${TEXT_ACTION_CLASS.primary}`} onClick={copy} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="mt-1 max-h-72 overflow-auto rounded-lg border border-hairline bg-fill p-2 text-xs break-all whitespace-pre-wrap text-ink select-text"
        data-testid={testId}
      >
        {text}
      </pre>
    </div>
  );
}
