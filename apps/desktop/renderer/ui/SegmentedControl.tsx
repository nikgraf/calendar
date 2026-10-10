import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  readonly disabled?: boolean | undefined;
  readonly label: ReactNode;
  readonly testId?: string | undefined;
  readonly title?: string | undefined;
  readonly value: T;
}

const SIZE = {
  md: 'px-3 py-1 text-sm',
  sm: 'px-2 py-0.5 text-xs',
} as const;

/**
 * One choice among a few, drawn as a soft-filled track with the chosen
 * segment lifted onto a surface — the view switcher, Event/Task, "Apply
 * to", Add/Find, priority. A radiogroup for assistive tech; `label` names
 * it.
 */
export function SegmentedControl<T extends string>({
  className = '',
  grow = false,
  label,
  onChange,
  options,
  size = 'md',
  value,
}: {
  readonly className?: string;
  /** Segments share the width equally (forms); off, each takes its own. */
  readonly grow?: boolean;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<SegmentedOption<T>>;
  readonly size?: keyof typeof SIZE;
  /** Undefined selects no segment: the choice is outside the presets. */
  readonly value: T | undefined;
}) {
  return (
    <div
      aria-label={label}
      className={`inline-flex rounded-control bg-fill p-0.5 ${className}`}
      role="radiogroup"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            aria-checked={active}
            className={`rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50 ${
              grow ? 'flex-1' : ''
            } ${active ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary hover:text-ink'} ${
              SIZE[size]
            }`}
            data-testid={option.testId}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            title={option.title}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
