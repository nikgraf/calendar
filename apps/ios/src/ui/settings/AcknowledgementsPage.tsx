import { ACKNOWLEDGEMENTS, LICENCES, type LicenceId } from '@calendar/core/acknowledgements';
import { LICENCE_TEXTS } from '@calendar/core/licenceTexts';
import { Linking } from 'react-native';
import { Footer, Row, Section, SettingsPage } from '../GroupedList.tsx';

/** The licences the entries use, each once, in a stable order. */
const USED: ReadonlyArray<LicenceId> = [
  ...new Set(ACKNOWLEDGEMENTS.map((entry) => entry.licence)),
].sort();

/**
 * Settings › Acknowledgements: the models, libraries and typeface whose
 * licences ask to be credited (`acknowledgements.ts`, the Mac's About
 * panel and THIRD_PARTY_NOTICES.md list the same): who made each, what
 * Solunivo does with it, what was changed and its copyright line; a row
 * opens its page. The licence texts follow in full.
 */
export function AcknowledgementsPage() {
  return (
    <SettingsPage testID="settings-page-acknowledgements">
      {ACKNOWLEDGEMENTS.map((entry) => (
        <Section
          footer={
            <Footer>
              {[entry.what, entry.changes, entry.copyright, LICENCES[entry.licence].name]
                .filter((line) => line !== undefined)
                .join(' ')}
            </Footer>
          }
          key={entry.name}
        >
          <Row
            onPress={() => void Linking.openURL(entry.url)}
            subtitle={`By ${entry.by}`}
            testID={`acknowledgement-${entry.name}`}
            title={entry.name}
          />
        </Section>
      ))}
      {USED.map((id) => (
        <Section
          footer={<Footer selectable>{LICENCE_TEXTS[id]}</Footer>}
          header={LICENCES[id].name}
          key={id}
        >
          <Row
            onPress={() => void Linking.openURL(LICENCES[id].url)}
            testID={`licence-${id}`}
            title={LICENCES[id].url}
          />
        </Section>
      ))}
    </SettingsPage>
  );
}
