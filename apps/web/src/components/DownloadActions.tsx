import { links, releases } from '../links.ts';
import { ButtonLink } from './Button.tsx';

type Platform = 'android' | 'ios' | 'linux' | 'mac' | 'windows';

const mac = { href: releases.mac ?? links.download, label: 'Download for macOS' };
const iphone = { href: releases.iphone ?? links.download, label: 'Get it for iPhone' };

/**
 * One group per platform; the stylesheet shows the one matching
 * `data-platform` on <html>, which the inline script sets from the user
 * agent, and the macOS group without it. Platforms the apps are not on yet
 * are told so and offered the nearest one to try.
 */
const groups: ReadonlyArray<{
  note?: string;
  platform: Platform;
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
}> = [
  { platform: 'mac', primary: mac, secondary: iphone },
  { platform: 'ios', primary: iphone, secondary: mac },
  {
    note: 'Windows is coming later.',
    platform: 'windows',
    primary: { ...mac, label: 'Try it on macOS' },
    secondary: iphone,
  },
  {
    note: 'Linux is coming later.',
    platform: 'linux',
    primary: { ...mac, label: 'Try it on macOS' },
    secondary: iphone,
  },
  {
    note: 'Android is coming later.',
    platform: 'android',
    primary: { ...iphone, label: 'Try it on iPhone' },
    secondary: mac,
  },
];

export function DownloadActions({ tone = 'default' }: { tone?: 'default' | 'inverted' }) {
  const primary = tone === 'inverted' ? 'inverted' : 'primary';
  const secondary = tone === 'inverted' ? 'invertedOutline' : 'outline';
  return (
    <>
      {groups.map((group) => (
        <div
          className="cta-group flex-col items-start gap-3"
          data-for={group.platform}
          key={group.platform}
        >
          {group.note ? <p className="m-0 text-[15px] text-ink-secondary">{group.note}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={group.primary.href} variant={primary}>
              {group.primary.label}
            </ButtonLink>
            <ButtonLink href={group.secondary.href} variant={secondary}>
              {group.secondary.label}
            </ButtonLink>
          </div>
        </div>
      ))}
    </>
  );
}
