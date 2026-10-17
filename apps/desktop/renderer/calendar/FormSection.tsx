import type { ReactNode } from 'react';

/** A section's caption in the editor's forms: small, uppercase, secondary. */
export const SECTION_LABEL_CLASS = 'text-xs font-medium text-ink-secondary uppercase';

/**
 * One group of an editor form under a caption — When, Where, Invitees,
 * Notifications, Notes — so the form reads as a few sections rather than
 * one run of fields: a little room inside, more between (the forms'
 * `gap-5`), no box around it.
 */
export function FormSection({
  children,
  label,
  testId,
}: {
  children: ReactNode;
  label: string;
  testId?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <p className={SECTION_LABEL_CLASS}>{label}</p>
      {children}
    </div>
  );
}
