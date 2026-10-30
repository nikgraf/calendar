import { renderToStaticMarkup } from 'react-dom/server';
import { Document } from './Document.tsx';
import { routes } from './routes.ts';
import './site.css';

export { routes };

/**
 * One route as a complete HTML document: no scripts, the given
 * stylesheets, and the font to preload when there is one.
 */
export function render(
  route: string,
  { css, font }: { css: ReadonlyArray<string>; font?: string | undefined },
): string {
  return `<!doctype html>${renderToStaticMarkup(<Document css={css} font={font} path={route} />)}`;
}
