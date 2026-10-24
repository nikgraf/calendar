import { Footer, SettingsPage } from '../GroupedList.tsx';
import { SettingsCodePanel } from '../settingsCode/SettingsCodePanel.tsx';

/**
 * Settings › Settings File › Show Code for Your Mac: this iPhone's
 * settings code, shown at once (the row already asked for it), with what
 * it carries and its text to copy.
 */
export function SettingsCodePage() {
  return (
    <SettingsPage testID="settings-page-code">
      <Footer>
        On the Mac, open Solunivo › Settings › Settings File › Copy from iPhone…, then hold this
        screen up to its camera — or copy the text and paste it there.
      </Footer>
      <SettingsCodePanel reveal={false} />
    </SettingsPage>
  );
}
