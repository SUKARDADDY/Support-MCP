// The release version. scripts/bump-version.mjs maintains it and test/version.test.js checks it against package.json.
export const VERSION = '0.3.0';
// A release version: strict SemVer, the pattern semver.org gives. No leading zeros in x.y.z or in a numeric
// prerelease identifier (1.2.3-01 is refused, 1.2.3-0a is not); build metadata may have them (+001).
// The relay applies it to a hello's version and scripts/bump-version.mjs applies it to its argument.
// The relay also caps a hello's version at 32 characters.
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
