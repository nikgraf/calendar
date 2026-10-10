import { NavRow, Section, SettingsPage } from './GroupedList.tsx';

/**
 * Advanced: troubleshooting a build — Diagnostics and PR Preview. The
 * settings file has its own page (SettingsFilePage), as on the Mac.
 */
export function AdvancedPage() {
  return (
    <SettingsPage testID="settings-page-advanced">
      <Section
        footer="PR Preview loads a pull request’s update into a TestFlight build."
        header="Troubleshooting"
      >
        <NavRow
          href="/settings/diagnostics"
          testID="settings-row-diagnostics"
          title="Diagnostics"
        />
        <NavRow href="/settings/pr-preview" testID="settings-row-pr-preview" title="PR Preview" />
      </Section>
    </SettingsPage>
  );
}
