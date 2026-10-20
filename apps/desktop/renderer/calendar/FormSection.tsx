import type { ReactNode, Ref } from 'react';

/** A section's caption in the editor's forms: small, uppercase, secondary. */
export const SECTION_LABEL_CLASS = 'text-xs font-medium text-ink-secondary uppercase';

/**
 * One group of an editor form under a caption — When, Where, Invitees,
 * Notifications, Notes — so the form reads as a few sections rather than
 * one run of fields: a little room inside, more between (the forms'
 * `gap-5`), no box around it. `ref`: a turn's flash (`useFieldFlash`)
 * tints the whole section, a few pixels past its text.
 */
export function FormSection({
  children,
  label,
  ref,
  testId,
}: {
  children: ReactNode;
  label: string;
  ref?: Ref<HTMLDivElement> | undefined;
  testId?: string | undefined;
}) {
  return (
    <div
      className="-m-1.5 flex flex-col gap-2 rounded-control p-1.5"
      data-testid={testId}
      ref={ref}
    >
      <p className={SECTION_LABEL_CLASS}>{label}</p>
      {children}
    </div>
  );
}
