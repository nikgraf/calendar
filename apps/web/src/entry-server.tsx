import { renderToStaticMarkup } from 'react-dom/server';
import { Document } from './Document.tsx';
import { routes } from './routes.ts';
import './site.css';

export { routes };

/** One route as a complete HTML document (no scripts, the given stylesheets). */
export function render(route: string, { css }: { css: ReadonlyArray<string> }): string {
  return `<!doctype html>${renderToStaticMarkup(<Document css={css} path={route} />)}`;
}
