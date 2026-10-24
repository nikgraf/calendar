import { useTheme } from '../theme.ts';
import { Footer, Glyph, NavRow, Row, Section, SettingsPage } from '../GroupedList.tsx';
import { useSettingsTransfer } from './useSettingsTransfer.ts';

/**
 * Settings File: the settings document carried between devices — first
 * as a code (show this iPhone's to the Mac, or read the Mac's), then as a
 * file, the Mac's pane minus its watched file. Export writes the
 * settings document to the cache folder and hands it to the share sheet
 * (AirDrop it to the Mac, save it to Files); Import picks a file and shows
 * what it would do before applying. The document never contains tokens: a
 * Google account from another device shows up as "reconnect". The setup's
 * copy door runs the same import (`useSettingsTransfer`).
 */
export function SettingsFilePage() {
  const { colors } = useTheme();
  const { busy, exportSettings, importSettings, notice } = useSettingsTransfer();

  return (
    <SettingsPage testID="settings-page-file">
      <Section
        footer="The quickest way to the Mac and back: one device shows its code, the other reads it. It holds account addresses and calendar choices, never passwords or tokens."
        header="Copy to Another Device"
        testID="settings-code-rows"
      >
        <NavRow href="/settings/code" testID="settings-row-code" title="Show Code for Your Mac" />
        <NavRow
          href="/settings/read-code"
          testID="settings-row-read-code"
          title="Read Code from Your Mac"
        />
      </Section>
      <Section
        footer={
          <>
            <Footer>
              Carry these settings to another iPhone or Mac as a file. It never contains passwords
              or tokens; a Google account from another device shows up as “reconnect” until you sign
              in. An import never removes anything.
            </Footer>
            {notice ? <Footer testID="settings-file-notice">{notice}</Footer> : null}
          </>
        }
        testID="settings-file"
      >
        <Row
          accessory={<Glyph name="square.and.arrow.up" size={18} tintColor={colors.primary} />}
          disabled={busy}
          onPress={() => void exportSettings()}
          testID="settings-file-export"
          title="Export Settings…"
          tone="tint"
        />
        <Row
          accessory={<Glyph name="square.and.arrow.down" size={18} tintColor={colors.primary} />}
          disabled={busy}
          onPress={() => void importSettings()}
          testID="settings-file-import"
          title="Import Settings…"
          tone="tint"
        />
      </Section>
    </SettingsPage>
  );
}
