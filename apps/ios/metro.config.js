// expo/metro-config has built-in monorepo support (workspace root watching +
// symlink resolution); no manual watchFolders needed.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
