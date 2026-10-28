/**
 * An image with a dark-scheme variant. The `<source>` follows the OS by
 * default, so the right file is picked before the first paint and without
 * JavaScript; the inline theme script rewrites its media query when the
 * visitor forces a scheme in the footer.
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
