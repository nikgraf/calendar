/** @type {import('@expo/fingerprint').Config} */
// The native bridges (packages/*/swift) reach the app through symlinks in
// modules/*/ios; the fingerprint hashes the modules directories without
// following them, so a Swift change alone never changed the runtime
// version and CI kept testing (and TestFlight kept shipping) the previous
// binary. Hash the real sources too.
module.exports = {
  extraSources: [
    '../../packages/apple-calendar/swift',
    '../../packages/contacts/swift',
    '../../packages/geo/swift',
    '../../packages/reminders/swift',
  ].map((filePath) => ({ filePath, reasons: ['native-bridge'], type: 'dir' })),
};
