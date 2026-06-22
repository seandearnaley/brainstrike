#!/usr/bin/env node
/**
 * Portable postinstall: make node-pty's macOS `spawn-helper` prebuilt binaries
 * executable.
 *
 * node-pty ships the helper as a plain file in its prebuilds; npm/pnpm do not
 * preserve the +x bit on extraction, so node-pty's `spawn()` fails on macOS
 * with EACCES until it is chmod'd. The original shell one-liner
 * (`chmod +x … 2>/dev/null || true`) is POSIX-only and BREAKS the desktop
 * install/build on Windows (no `chmod`, no `/dev/null`, no `|| true` under
 * `cmd.exe`). This script:
 *   - no-ops on every non-darwin platform (the helper is darwin-only),
 *   - resolves node-pty's real install dir via `require.resolve` (works through
 *     pnpm's symlinked store), and
 *   - chmods each darwin `spawn-helper` under `prebuilds/` via `fs.chmodSync`
 *     (no shell syntax).
 *
 * It NEVER fails the install: a missing node-pty (e.g. a future build that
 * drops it) or an already-correct mode is logged and ignored, but a real
 * chmod error IS surfaced to stderr (no silent fallback) without a non-zero
 * exit, so install/build keeps going on the platforms where node-pty is unused.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform !== 'darwin') {
  // The spawn-helper prebuild only exists for darwin; nothing to do elsewhere
  // (notably Windows, where the old shell command could not run at all).
  process.exit(0);
}

function resolveNodePtyDir() {
  try {
    const require = createRequire(import.meta.url);
    // node-pty's main is `lib/index.js`; walk up to the package root.
    const main = require.resolve('node-pty');
    let dir = path.dirname(main);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // node-pty not installed (or not resolvable from here) — nothing to chmod.
  }
  return null;
}

const ptyDir = resolveNodePtyDir();
if (!ptyDir) {
  process.exit(0);
}

const prebuildsDir = path.join(ptyDir, 'prebuilds');
if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

let chmodded = 0;
for (const entry of readdirSync(prebuildsDir)) {
  if (!entry.startsWith('darwin-')) {
    continue;
  }
  const helper = path.join(prebuildsDir, entry, 'spawn-helper');
  if (!existsSync(helper)) {
    continue;
  }
  try {
    // rwxr-xr-x — match what node-pty expects for the helper binary.
    chmodSync(helper, statSync(helper).mode | 0o111);
    chmodded += 1;
  } catch (error) {
    // A real chmod failure is surfaced (no-silent-fallbacks) but does not fail
    // the whole install — node-pty is only used at runtime on darwin desktop.
    process.stderr.write(
      `[chmod-pty-spawn-helper] failed to chmod ${helper}: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }
}

if (chmodded === 0) {
  process.stderr.write('[chmod-pty-spawn-helper] no darwin spawn-helper found to chmod\n');
}
