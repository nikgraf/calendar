import lockup from '../../../../brand/logos/lockup-horizontal-light.svg';
import { links } from '../links.ts';

const items = [
  { href: '/#features', label: 'Features' },
  { href: '/#iphone', label: 'iPhone' },
  { href: '/#ai', label: 'AI' },
  { href: '/#privacy', label: 'Privacy' },
];

export function Nav() {
  return (
    <header className="border-b border-hairline">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-4 sm:px-8">
        <a aria-label="Solunivo home" className="inline-flex items-center" href="/">
          <img alt="" className="block h-[30px] w-auto" height="30" src={lockup} />
        </a>
        <nav
          aria-label="Primary"
          className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm font-medium"
        >
          {items.map((item) => (
            <a
              className="py-2 no-underline hover:text-ink-secondary"
              href={item.href}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
          <a
            className="rounded-control bg-primary px-3.5 py-2 text-on-primary no-underline hover:bg-primary-hover"
            href={links.download}
          >
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
