import { links } from '../links.ts';

const schemes = [
  { label: 'Auto', value: 'auto' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
] as const;

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-7 text-sm text-ink-secondary sm:px-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span>© 2026 Solunivo</span>
          <a className="no-underline hover:text-ink" href={links.privacy}>
            Privacy policy
          </a>
        </div>
        {/* The inline theme script applies the choice and marks the pressed button. */}
        <div
          aria-label="Color scheme"
          className="theme-switch flex rounded-control bg-surface-subtle p-0.5 text-[13px] font-medium"
          role="group"
        >
          {schemes.map((scheme) => (
            <button
              aria-pressed={scheme.value === 'auto'}
              className="rounded-[6px] px-3 py-1.5 text-ink-secondary hover:text-ink"
              data-set-theme={scheme.value}
              key={scheme.value}
              type="button"
            >
              {scheme.label}
            </button>
          ))}
        </div>
      </div>
    </footer>
  );
}
