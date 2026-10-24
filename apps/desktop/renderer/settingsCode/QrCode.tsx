import { qrPathData, type SettingsQr } from '@calendar/core/settingsCode';

/**
 * A settings code's QR as one SVG path: black on white in both themes —
 * cameras look for dark modules on a light field — with the four-module
 * quiet zone inside the white square, so nothing around it matters.
 * Literal colors on purpose: the code is not part of the theme.
 */
export function QrCode({ qr, size }: { qr: SettingsQr; size: number }) {
  return (
    <svg
      aria-label="Setup code"
      data-testid="settings-code-qr"
      data-version={qr.version}
      height={size}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
      width={size}
    >
      <rect fill="#ffffff" height={qr.size} width={qr.size} />
      <path d={qrPathData(qr)} fill="#000000" />
    </svg>
  );
}
