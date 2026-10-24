import { qrPng, type SettingsQr } from '@calendar/core/settingsCode';
import { useMemo } from 'react';
import { Image, PixelRatio } from 'react-native';

/**
 * A settings code's QR as a 1-bit PNG in RN's own Image — no SVG
 * renderer, one element in the view tree. Drawn at whole device pixels a
 * module, so nothing is resampled and every edge stays sharp; `width` is
 * the most it may take, in points. Black on white whatever the theme: the
 * four-module quiet zone is part of the image.
 */
export function SettingsCodeImage({ qr, width }: { qr: SettingsQr; width: number }) {
  const ratio = PixelRatio.get();
  const scale = Math.max(1, Math.floor((width * ratio) / qr.size));
  const side = (qr.size * scale) / ratio;
  const uri = useMemo(() => qrPng(qr, scale), [qr, scale]);
  return (
    <Image
      accessibilityLabel="Setup code"
      accessible
      source={{ uri }}
      style={{ height: side, width: side }}
      testID="settings-code-image"
    />
  );
}
