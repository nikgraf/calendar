import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DownloadActions } from './components/DownloadActions.tsx';
import { render, routes } from './entry-server.tsx';
import { routeFor } from './routes.ts';

// The build's markdown plugin is not part of the test pipeline; the page
// only needs some HTML to place.
vi.mock('../../../PRIVACY.md', () => ({
  default: '<h1>Privacy Policy</h1>\n<p>Solunivo has no server of its own.</p>',
}));

describe('routes', () => {
  it('normalizes trailing slashes and falls back to home', () => {
    expect(routeFor('/')).toBe('/');
    expect(routeFor('/privacy')).toBe('/privacy');
    expect(routeFor('/privacy/')).toBe('/privacy');
    expect(routeFor('/nope')).toBe('/');
  });
});

describe('render', () => {
  const css = ['/assets/site-abc.css'];

  it('renders every route as a complete document with only the inline theme script', () => {
    for (const route of routes) {
      const html = render(route, { css });
      expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
      expect(html).toContain('<link href="/assets/site-abc.css" rel="stylesheet"/>');
      expect(html).toContain('name="viewport"');
      // One inline script, in the head so the first paint has the scheme;
      // no script loads from a URL.
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html).not.toMatch(/<script[^>]*\ssrc=/);
      const script = html.indexOf('solunivo-theme');
      expect(script).toBeGreaterThan(-1);
      expect(script).toBeLessThan(html.indexOf('<body'));
      expect(html).toContain('<meta content="light dark" name="color-scheme"/>');
      // The first link on the page skips the nav.
      expect(html.match(/<a [^>]*>/)?.[0]).toContain('href="#main"');
      expect(html).toContain('id="main"');
    }
  });

  it('preloads the font when the build names one', () => {
    expect(render('/', { css })).not.toContain('as="font"');
    expect(render('/', { css, font: '/assets/InterVariable-1234abcd.woff2' })).toContain(
      '<link as="font" crossorigin="" href="/assets/InterVariable-1234abcd.woff2" rel="preload" type="font/woff2"/>',
    );
  });

  it('puts the home sections and the calls to action on the front page', () => {
    const html = render('/', { css });
    for (const id of ['ai', 'features', 'privacy', 'roadmap', 'download']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Download for macOS');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('<link href="https://solunivo.com/" rel="canonical"/>');
  });

  it('offers every platform its own download group', () => {
    const html = render('/', { css });
    for (const platform of ['mac', 'ios', 'windows', 'linux', 'android']) {
      expect(html).toContain(`data-for="${platform}"`);
    }
    // Platforms the apps are not on yet point at the roadmap.
    expect(html).toContain('Linux is <a');
    expect(html.match(/ is <a [^>]*href="\/#roadmap"/g)).toHaveLength(3);
    expect(html).toContain('Try it on iPhone');
  });

  it('says Outlook and CalDAV work through Apple Calendar, and native support is on the roadmap', () => {
    const html = render('/', { css });
    expect(html).toContain('Outlook and CalDAV via Apple Calendar');
    expect(html).toContain('Outlook, Exchange and CalDAV accounts that Apple Calendar syncs');
    expect(html).toContain('invitations stay in Apple Calendar');
    expect(html).toContain('href="#roadmap"');
    // Six feature cards: the three account sources, then three more.
    const features = html.slice(html.indexOf('id="features"'), html.indexOf('id="privacy"'));
    expect(features.match(/<li /g)).toHaveLength(6);
  });

  it('lists the roadmap: native Outlook and JMAP, then Android, Windows and Linux', () => {
    const html = render('/', { css });
    const nav = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(nav).toContain('href="/#roadmap"');
    const roadmap = html.slice(html.indexOf('id="roadmap"'), html.indexOf('id="download"'));
    const items = [...roadmap.matchAll(/<strong[^>]*>([^<]+)<\/strong>/g)].map((match) => match[1]);
    expect(items).toEqual([
      'Native Microsoft Outlook',
      'Native JMAP',
      'Android',
      'Windows',
      'Linux',
    ]);
  });

  it('swaps the screenshots and lockups by color scheme', () => {
    const html = render('/', { css });
    const sources = html.match(/<source [^>]*data-theme-source="dark"[^>]*>/g) ?? [];
    // The nav lockup, the two hero screenshots and the download band's lockup.
    expect(sources).toHaveLength(4);
    for (const source of sources) {
      expect(source).toContain('media="(prefers-color-scheme: dark)"');
      // React writes the attribute as `srcSet`; HTML attribute names are case-insensitive.
      expect(source).toMatch(/srcset="[^"]+"/i);
    }
    expect(html).toMatch(/fetchpriority="high"/i);
  });

  it('has a scheme switch in the footer on every page', () => {
    for (const route of routes) {
      const html = render(route, { css });
      for (const choice of ['auto', 'light', 'dark']) {
        expect(html).toContain(`data-set-theme="${choice}"`);
      }
      expect(html).toContain('aria-pressed="true"');
    }
  });

  it('says the apps are in private testing instead of linking the download section to itself', () => {
    const html = render('/', { css });
    const band = html.slice(html.indexOf('id="download"'));
    const section = band.slice(0, band.indexOf('</section>'));
    expect(section).toContain('private testing');
    expect(section).not.toContain('href="/#download"');
  });

  it('gives an app without a public link no button in the download band once the other has one', () => {
    const mac = 'https://example.com/Solunivo.zip';
    const band = renderToStaticMarkup(<DownloadActions releases={{ mac }} tone="inverted" />);
    expect(band).toContain(`href="${mac}"`);
    expect(band).not.toContain('href="/#download"');
    expect(band).not.toContain('Get it for iPhone');
    // Android's group falls back to the Mac as its one button, under the note.
    const android = band.slice(band.indexOf('data-for="android"'));
    expect(android).toContain('Android is <a');
    expect(android).toContain('Download for macOS');
    expect(band).toContain('text-on-primary/70');
    // The roadmap link in the band's note stays light on the ink.
    expect(android).toMatch(/<a class="text-on-primary underline[^"]*" href="\/#roadmap"/);
    expect(band).not.toContain('text-ink-secondary');

    // Above the band, the iPhone button still leads down to it.
    const hero = renderToStaticMarkup(<DownloadActions releases={{ mac }} />);
    expect(hero).toContain('href="/#download"');
    expect(hero).toContain('Get it for iPhone');
  });

  it('renders the privacy policy from its Markdown', () => {
    const html = render('/privacy', { css });
    expect(html).toContain('<title>Privacy Policy — Solunivo</title>');
    expect(html).toContain('<h1>Privacy Policy</h1>');
    expect(html).toContain('<link href="https://solunivo.com/privacy" rel="canonical"/>');
  });
});
