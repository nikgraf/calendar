import { links, releases as published } from '../links.ts';
import { ButtonLink } from './Button.tsx';

type Platform = 'android' | 'ios' | 'linux' | 'mac' | 'windows';
type Releases = { readonly iphone?: string | undefined; readonly mac?: string | undefined };
type Target = { href: string | undefined; label: string };

/**
 * One group per platform; the stylesheet shows the one matching
 * `data-platform` on <html>, which the inline script sets from the user
 * agent, and the macOS group without it. Platforms the apps are not on yet
 * are told so and offered the nearest one to try.
 */
const groupsFor = (
  releases: Releases,
): ReadonlyArray<{ note?: string; platform: Platform; primary: Target; secondary: Target }> => {
  const mac = { href: releases.mac, label: 'Download for macOS' };
  const iphone = { href: releases.iphone, label: 'Get it for iPhone' };
  return [
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
};

/**
 * An app with no public link yet leads to the download section, which says
 * so; inside that section (`inverted`) it gets no button, since its link
 * would lead to the section itself.
 */
export function DownloadActions({
  releases = published,
  tone = 'default',
}: {
  releases?: Releases;
  tone?: 'default' | 'inverted';
}) {
  const inverted = tone === 'inverted';
  return (
    <>
      {groupsFor(releases).map((group) => (
        <div
          className="cta-group flex-col items-start gap-3"
          data-for={group.platform}
          key={group.platform}
        >
          {group.note ? (
            <p
              className={`m-0 text-[15px] ${inverted ? 'text-on-primary/70' : 'text-ink-secondary'}`}
            >
              {group.note}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {[group.primary, group.secondary]
              .filter((target) => target.href || !inverted)
              .map((target, index) => (
                <ButtonLink
                  href={target.href ?? links.download}
                  key={target.label}
                  variant={
                    index === 0
                      ? inverted
                        ? 'inverted'
                        : 'primary'
                      : inverted
                        ? 'invertedOutline'
                        : 'outline'
                  }
                >
                  {target.label}
                </ButtonLink>
              ))}
          </div>
        </div>
      ))}
    </>
  );
}
