import touchIcon from '../../ios/assets/icon.png';
import favicon from '../../../brand/icons/solunivo.svg';
import { App } from './App.tsx';
import { pageMeta, routeFor } from './routes.ts';

const origin = 'https://solunivo.com';

/** The whole HTML document for one route, used by the static build. */
export function Document({
  css,
  font,
  path,
}: {
  css: ReadonlyArray<string>;
  font?: string | undefined;
  path: string;
}) {
  const route = routeFor(path);
  const meta = pageMeta[route];
  const url = route === '/' ? `${origin}/` : `${origin}${route}`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <title>{meta.title}</title>
        <meta content={meta.description} name="description" />
        <link href={url} rel="canonical" />
        <meta content="Solunivo" property="og:site_name" />
        <meta content="website" property="og:type" />
        <meta content={meta.title} property="og:title" />
        <meta content={meta.description} property="og:description" />
        <meta content={url} property="og:url" />
        <meta content="summary" name="twitter:card" />
        <link href={favicon} rel="icon" type="image/svg+xml" />
        <link href={touchIcon} rel="apple-touch-icon" />
        {font ? (
          <link as="font" crossOrigin="" href={font} rel="preload" type="font/woff2" />
        ) : null}
        {css.map((href) => (
          <link href={href} key={href} rel="stylesheet" />
        ))}
      </head>
      <body>
        <App path={route} />
      </body>
    </html>
  );
}
