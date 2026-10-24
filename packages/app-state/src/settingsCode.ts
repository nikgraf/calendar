import type { SettingsDocument } from '@calendar/core';
import {
  describeSettingsDocument,
  encodeSettingsCode,
  settingsCodeDocument,
  settingsCodeQr,
  type SettingsQr,
} from '@calendar/core/settingsCode';
import { useAtomValue } from '@effect/atom-react';
import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useMemo } from 'react';
import { useBackendAtoms } from './hooks.ts';

/** This device's settings as a code: its text, its QR (null past version 40) and what it carries. */
export interface SettingsCodeView {
  readonly code: string;
  readonly lines: ReadonlyArray<string>;
  readonly qr: SettingsQr | null;
}

/** The pure part, from a document to what a code panel shows. */
export const settingsCodeView = (document: SettingsDocument): SettingsCodeView => {
  const code = encodeSettingsCode(document);
  return {
    code,
    lines: describeSettingsDocument(settingsCodeDocument(document)),
    qr: Option.getOrNull(Effect.runSync(Effect.option(settingsCodeQr(code)))),
  };
};

/** The settings document Export writes; null until the first read resolves. */
export const useSettingsDocument = (): SettingsDocument | null => {
  const result = useAtomValue(useBackendAtoms().settingsDocument);
  return Option.getOrNull(AsyncResult.value(result));
};

/**
 * This device's settings code, rebuilt only when the document's content
 * changes (a re-read that finds the same settings keeps the same QR).
 */
export const useSettingsCode = (): SettingsCodeView | null => {
  const document = useSettingsDocument();
  const json = document === null ? null : JSON.stringify(document);
  return useMemo(
    () => (json === null ? null : settingsCodeView(JSON.parse(json) as SettingsDocument)),
    [json],
  );
};
