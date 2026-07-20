'use strict';

/**
 * Preflight for the native test suite: fail with an ACTIONABLE message when the
 * compiled addon is absent, instead of letting `bindings` throw its generic
 * "Could not locate the bindings file" wall of candidate paths.
 *
 * This is deliberately a CHECK, never a build. The package `test` script must
 * not compile anything inline: turbo schedules this package's `build` task
 * independently, and an inline `node-gyp rebuild` (= clean + configure + build)
 * raced that task as two concurrent rebuilds in one directory. The ordering now
 * comes from `dependsOn: ["$TURBO_EXTENDS$", "build"]` in turbo.json, so under
 * turbo the addon is always present here and this check is a no-op.
 *
 * Auto-building on a miss was considered and rejected: it would silently reuse a
 * STALE addon after a C++ edit on the direct-invocation path (the inline build
 * it replaced always recompiled), which is the silent-fallback failure mode this
 * repo forbids. Failing loudly keeps the build step explicit and visible.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');

const addonPath = path.join(__dirname, '..', 'build', 'Release', 'secure_fs_native.node');

if (!existsSync(addonPath)) {
  process.stderr.write(
    `\nsecure-fs-native: compiled addon not found at\n  ${addonPath}\n\n` +
      'This suite loads a native binary and does NOT build it inline. Build it first:\n\n' +
      '  pnpm --filter @brainstrike/secure-fs-native build\n\n' +
      'Or run through turbo, which supplies the build via its dependsOn edge:\n\n' +
      '  pnpm turbo run test --filter=@brainstrike/secure-fs-native\n\n'
  );
  process.exit(1);
}
