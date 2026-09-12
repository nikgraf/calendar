// Birthday reminders are local notifications only, but prebuild applies
// expo-notifications' own config plugin automatically and that plugin
// adds the `aps-environment` (push) entitlement. Our App Store provisioning
// profile has no Push Notifications capability, so the entitlement failed
// the TestFlight build ("doesn't include the aps-environment entitlement")
// for a capability the app never uses. Plugins listed in app.json run
// after the auto-applied ones, so this one removes it again.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = (config) =>
  withEntitlementsPlist(config, (entitlements) => {
    delete entitlements.modResults['aps-environment'];
    return entitlements;
  });
