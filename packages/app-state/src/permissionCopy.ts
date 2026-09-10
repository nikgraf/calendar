/**
 * Human-readable permission states for the two native bridges. Desktop
 * had these as two STATUS_COPY tables; iOS showed the raw enum in its
 * Diagnostics card ("reminders: notDetermined"). `settingsPath` is where
 * the platform keeps the toggle: "System Settings › Privacy & Security"
 * on macOS, "Settings › Privacy & Security" on iOS.
 */
export const remindersStatusCopy = (status: string, settingsPath: string): string => {
  switch (status) {
    case 'denied':
      return `Access denied — allow Solunivo under ${settingsPath} › Reminders.`;
    case 'fullAccess':
      return 'Access granted.';
    case 'notDetermined':
      return 'Not asked yet.';
    case 'restricted':
      return 'Restricted by a device policy.';
    case 'unavailable':
      return 'Unavailable in this build.';
    case 'writeOnly':
      return 'Write-only access — full access is needed to show reminders.';
    default:
      return status;
  }
};

export const contactsStatusCopy = (status: string, settingsPath: string): string => {
  switch (status) {
    case 'authorized':
      return 'Access granted — people from your address book appear as you type an invitee.';
    case 'denied':
      return `Access denied — allow Solunivo under ${settingsPath} › Contacts.`;
    case 'limited':
      return 'Partial access granted.';
    case 'notDetermined':
      return 'Not asked yet.';
    case 'restricted':
      return 'Restricted by a device policy.';
    case 'unavailable':
      return 'Unavailable in this build.';
    default:
      return status;
  }
};
