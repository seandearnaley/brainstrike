'use strict';

/**
 * Preflight for the native test suite: fail with an ACTIONABLE message when this
 * platform's shipped binaries are absent, instead of letting the first `dlopen`
 * surface a generic loader error.
 *
 * Unlike packages/secure-fs-native, nothing here is ever compiled. The binaries
 * are the prebuilds the two npm packages ship, so the only remedy for a miss is
 * an install, never a build. `better-sqlite3` is denied in pnpm `allowBuilds`
 * and electron-builder runs with `npmRebuild: false`; a "fix" that invokes
 * node-gyp would reintroduce the failure this package exists to prevent.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');

const platform = `${process.platform}-${process.arch}`;
const missing = [];

const betterSqlite3 = path.join(
  path.dirname(require.resolve('better-sqlite3/package.json')),
  'prebuilds',
  `${platform}.node`
);
if (!existsSync(betterSqlite3)) {
  missing.push(`better-sqlite3 prebuild: ${betterSqlite3}`);
}

try {
  const vec0 = require('sqlite-vec').getLoadablePath();
  if (!existsSync(vec0)) {
    missing.push(`sqlite-vec extension: ${vec0}`);
  }
} catch (error) {
  missing.push(`sqlite-vec extension: ${error instanceof Error ? error.message : String(error)}`);
}

if (missing.length > 0) {
  process.stderr.write(
    `\nsqlite-native: prebuilt natives not found for ${platform}\n  ${missing.join('\n  ')}\n\n` +
      'These are shipped by the npm packages and are never compiled here. Install them:\n\n' +
      '  pnpm install --frozen-lockfile\n\n'
  );
  process.exit(1);
}
