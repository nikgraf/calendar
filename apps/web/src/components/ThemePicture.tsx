/**
 * An image with a dark-scheme variant. The `<source>` follows the OS, with
 * or without JavaScript, as the page's colors do; when the visitor forces a
 * scheme in the footer, the inline theme script rewrites its media query.
 * The browser may then have fetched the OS's variant too: only the shown
 * one is the forced scheme's.
 */
export function ThemePicture({
  alt,
  className,
  dark,
  fetchPriority,
  height,
  light,
  loading,
  width,
}: {
  alt: string;
  className?: string | undefined;
  dark: string;
  fetchPriority?: 'high' | 'low' | undefined;
  height: number;
  light: string;
  loading?: 'eager' | 'lazy' | undefined;
  width: number;
}) {
  return (
    <picture>
      <source data-theme-source="dark" media="(prefers-color-scheme: dark)" srcSet={dark} />
      <img
        alt={alt}
        className={className}
        fetchPriority={fetchPriority}
        height={height}
        loading={loading}
        src={light}
        width={width}
      />
    </picture>
  );
}
