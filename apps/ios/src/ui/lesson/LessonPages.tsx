import { contactsStatusCopy, useLessonTried } from '@calendar/app-state';
import { useTheme } from '../theme.ts';
import { CapsuleButton, Footer, Glyph, IconTile, Row, Section } from '../GroupedList.tsx';
import { NotificationsSections } from '../settings/NotificationsPage.tsx';
import { IOS_SETTINGS_PATH, useSettingsConnections } from '../settings/SettingsContext.tsx';
import { TimeZonesSections } from '../settings/TimeZonesPage.tsx';
import { useSettingsTransfer } from '../settings/useSettingsTransfer.ts';
import { SettingsCodePanel } from '../settingsCode/SettingsCodePanel.tsx';
import { LessonFrame } from './LessonFrame.tsx';

/** Alerts: the Notifications page's sections, as they are in Settings. */
export function LessonAlerts() {
  return (
    <LessonFrame id="alerts">
      <NotificationsSections />
    </LessonFrame>
  );
}

/** Contacts on this iPhone: the one ask, and what it is for. */
export function LessonContacts() {
  return (
    <LessonFrame id="contacts">
      <ContactsBody />
    </LessonFrame>
  );
}

/** Below the frame, so `useLessonTried` reads the frame's context. */
function ContactsBody() {
  const { colors } = useTheme();
  const { busy, connectDevice, connecting, contacts, contactsConnectionFailed, error } =
    useSettingsConnections();
  const tried = useLessonTried();
  const connected =
    (contacts === 'authorized' || contacts === 'limited') && !contactsConnectionFailed;
  // Only a grant is a try: a refusal, or a tap while another ask is on
  // screen, leaves the lesson open.
  const allow = async () => {
    if ((await connectDevice('contacts')) === true) {
      tried();
    }
  };
  return (
    <>
      <Section
        footer={
          <>
            <Footer>
              Read on this iPhone only, never uploaded. iOS asks once; change it in Settings › On
              This iPhone. Your Google contacts already come with the Google sign-in.
            </Footer>
            {error ? <Footer tone="danger">{error}</Footer> : null}
          </>
        }
      >
        <Row
          accessory={
            connected ? undefined : (
              <CapsuleButton
                disabled={busy}
                label={connecting === 'contacts' ? 'Asking…' : 'Allow Access'}
                onPress={() => void allow()}
                testID="lesson-allow-contacts"
              />
            )
          }
          leading={<IconTile color={colors['border-strong']} name="person.fill" />}
          subtitle={connected ? undefined : contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}
          title="Contacts"
          value={connected ? (contacts === 'limited' ? 'Selected Contacts' : 'Allowed') : undefined}
        />
      </Section>
      <Section header="What it gives you">
        <Row
          leading={<IconTile color={colors['event-blue-edge']} name="person.2.fill" />}
          subtitle="Type a name, get the address — in the editor and in “invite Sam” phrases"
          title="Invitees"
        />
        <Row
          leading={<IconTile color={colors['event-blush-edge']} name="gift.fill" />}
          subtitle="Birthdays on the calendar, and a reminder before each"
          title="Birthdays"
        />
      </Section>
    </>
  );
}

/** Time zones: the Time Zones page's list, as it is in Settings. */
export function LessonZones() {
  return (
    <LessonFrame id="zones">
      <TimeZonesSections />
    </LessonFrame>
  );
}

/** Set up your Mac: this iPhone's settings code, and the file as the fallback. */
export function LessonOtherDevice() {
  return (
    <LessonFrame id="otherDevice">
      <OtherDeviceBody />
    </LessonFrame>
  );
}

/**
 * Below the frame, so `useLessonTried` reads the frame's context. The code
 * waits behind Show Code; the reveal, its copy, or a file that went
 * somewhere is the try.
 */
function OtherDeviceBody() {
  const { colors } = useTheme();
  const { busy, exportSettings, notice } = useSettingsTransfer();
  const tried = useLessonTried();
  const share = async () => {
    if (await exportSettings()) {
      tried();
    }
  };
  return (
    <>
      <SettingsCodePanel onTried={tried} reveal />
      <Section
        footer={
          <>
            <Footer>
              Or as a file: export it, AirDrop it to the Mac, and import it there under Settings ›
              Settings File.
            </Footer>
            {notice ? <Footer testID="lesson-export-notice">{notice}</Footer> : null}
          </>
        }
      >
        <Row
          accessory={<Glyph name="square.and.arrow.up" size={18} tintColor={colors.primary} />}
          disabled={busy}
          onPress={() => void share()}
          testID="lesson-export-file"
          title="Export Settings…"
          tone="tint"
        />
      </Section>
    </>
  );
}
