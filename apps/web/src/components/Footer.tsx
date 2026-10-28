import { links } from '../links.ts';

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-7 text-sm text-ink-secondary sm:px-8">
        <span>© 2026 Solunivo</span>
        <nav aria-label="Footer" className="flex flex-wrap gap-6">
          <a className="no-underline hover:text-ink" href={links.privacy}>
            Privacy policy
          </a>
        </nav>
      </div>
    </footer>
  );
}
