import { describe, expect, it, vi } from 'vite-plus/test';
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

  it('renders every route as a complete document without scripts', () => {
    for (const route of routes) {
      const html = render(route, { css });
      expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
      expect(html).toContain('<link href="/assets/site-abc.css" rel="stylesheet"/>');
      expect(html).toContain('name="viewport"');
      expect(html).not.toContain('<script');
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
    for (const id of ['features', 'iphone', 'ai', 'privacy', 'download']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Download for Mac');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('<link href="https://solunivo.com/" rel="canonical"/>');
  });

  it('says the apps are in private testing instead of linking the download section to itself', () => {
    const html = render('/', { css });
    const band = html.slice(html.indexOf('id="download"'));
    const section = band.slice(0, band.indexOf('</section>'));
    expect(section).toContain('private testing');
    expect(section).not.toContain('href="/#download"');
  });

  it('renders the privacy policy from its Markdown', () => {
    const html = render('/privacy', { css });
    expect(html).toContain('<title>Privacy Policy — Solunivo</title>');
    expect(html).toContain('<h1>Privacy Policy</h1>');
    expect(html).toContain('<link href="https://solunivo.com/privacy" rel="canonical"/>');
  });
});
