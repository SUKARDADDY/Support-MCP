// The release version. scripts/bump-version.mjs maintains it and test/version.test.js checks it against package.json.
export const VERSION = '0.2.0';
// A release version: strict SemVer (no leading zeros). The relay applies it to a hello's version and
// scripts/bump-version.mjs applies it to its argument. The relay also caps a hello's version at 32 characters.
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
