import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { DownloadActions } from './components/DownloadActions.tsx';

describe('built website', () => {
  let dist: string;
  let home: string;
  let privacy: string;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'solunivo-web-'));
    await promisify(execFile)('pnpm', ['exec', 'astro', 'build', '--outDir', dist], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    });
    [home, privacy] = await Promise.all([
      readFile(join(dist, 'index.html'), 'utf8'),
      readFile(join(dist, 'privacy.html'), 'utf8'),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dist) {
      await rm(dist, { force: true, recursive: true });
    }
  });

  it('renders every route as a complete document with only the inline theme script', () => {
    for (const html of [home, privacy]) {
      expect(html).toMatch(/^<!doctype html><html lang="en">/i);
      expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/[^"]+\.css">/);
      expect(html).toContain('name="viewport"');
      // One inline script, in the head so the first paint has the scheme;
      // no script loads from a URL.
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html).not.toMatch(/<script[^>]*\ssrc=/);
      const script = html.indexOf('solunivo-theme');
      expect(script).toBeGreaterThan(-1);
      expect(script).toBeLessThan(html.indexOf('<body'));
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      // The first link on the page skips the nav.
      expect(html.match(/<a [^>]*>/)?.[0]).toContain('href="#main"');
      expect(html).toContain('id="main"');
    }
  });

  it('preloads the same subset font that the page actually uses', async () => {
    for (const html of [home, privacy]) {
      const font = html.match(/<link rel="preload" as="font"[^>]+href="([^"]+\.woff2)"/)?.[1];
      expect(font).toMatch(/^\/assets\/InterVariable-[\da-f]{8}\.woff2$/);
      expect(html).toContain(`url(${font})`);
      const { size } = await stat(join(dist, font ?? ''));
      expect(size).toBeGreaterThan(0);
      const full = await stat(new URL('../../../brand/fonts/InterVariable.woff2', import.meta.url));
      expect(size).toBeLessThan(full.size);
    }
  });

  it('puts the home sections and the calls to action on the front page', () => {
    for (const id of ['ai', 'features', 'privacy', 'roadmap', 'download']) {
      expect(home).toContain(`id="${id}"`);
    }
    expect(home).toContain('Download for macOS');
    expect(home).toContain('href="/privacy"');
    expect(home).toContain('<link rel="canonical" href="https://solunivo.com/">');
  });

  it('offers every platform its own download group', () => {
    for (const platform of ['mac', 'ios', 'windows', 'linux', 'android']) {
      expect(home).toContain(`data-for="${platform}"`);
    }
    // Platforms the apps are not on yet point at the roadmap.
    expect(home).toContain('Linux is <a');
    expect(home.match(/ is <a [^>]*href="\/#roadmap"/g)).toHaveLength(3);
    expect(home).toContain('Try it on iPhone');
  });

  it('says quick add runs on a model of its own on both devices', () => {
    expect(home).toContain('Quick add runs on a model of its own, on the iPhone and the Mac');
  });

  it('says Outlook and CalDAV work through Apple Calendar, and native support is on the roadmap', () => {
    expect(home).toContain('Outlook and CalDAV via Apple Calendar');
    expect(home).toContain('Outlook, Exchange and CalDAV accounts that Apple Calendar syncs');
    expect(home).toContain('invitations stay in Apple Calendar');
    expect(home).toContain('href="#roadmap"');
    // Six feature cards: the three account sources, then three more.
    const features = home.slice(home.indexOf('id="features"'), home.indexOf('id="privacy"'));
    expect(features.match(/<li /g)).toHaveLength(6);
  });

  it('lists the roadmap: native Outlook and JMAP, then Android, Windows and Linux', () => {
    const nav = home.slice(home.indexOf('<header'), home.indexOf('</header>'));
    expect(nav).toContain('href="/#roadmap"');
    const roadmap = home.slice(home.indexOf('id="roadmap"'), home.indexOf('id="download"'));
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
    const sources = home.match(/<source [^>]*data-theme-source="dark"[^>]*>/g) ?? [];
    // The nav lockup, the two hero screenshots and the download band's lockup.
    expect(sources).toHaveLength(4);
    for (const source of sources) {
      expect(source).toContain('media="(prefers-color-scheme: dark)"');
      // React writes the attribute as `srcSet`; HTML attribute names are case-insensitive.
      expect(source).toMatch(/srcset="[^"]+"/i);
    }
    expect(home).toMatch(/fetchpriority="high"/i);
  });

  it('has a scheme switch in the footer on every page', () => {
    for (const html of [home, privacy]) {
      for (const choice of ['auto', 'light', 'dark']) {
        expect(html).toContain(`data-set-theme="${choice}"`);
      }
      expect(html).toContain('aria-pressed="true"');
    }
  });

  it('says the apps are in private testing instead of linking the download section to itself', () => {
    const band = home.slice(home.indexOf('id="download"'));
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
    expect(privacy).toContain('<title>Privacy Policy — Solunivo</title>');
    expect(privacy).toContain('<h1 id="privacy-policy">Privacy Policy</h1>');
    expect(privacy).toContain('app talks directly from your device to Google and Apple');
    expect(privacy).toContain('<link rel="canonical" href="https://solunivo.com/privacy">');
  });
});
