#!/usr/bin/env node
// BST-568 packaging-matrix check: proves the @parcel/watcher native binding
// for THIS platform/arch loads and delivers a real filesystem event.
//
// Prints a single JSON line on stdout:
//   ok:    { ok: true, platform, arch, backend, prebuildPackage, subscribeMs, firstEventMs }
//   fail:  { ok: false, platform, arch, backend, error: { code, message } } and exit 1
//
// Intended to run both in CI lanes and inside a packaged Electron app
// (via `node` or the embedded runtime) to catch missing/wrong-arch prebuilds
// loudly. The @parcel/watcher install script is deliberately disallowed in
// pnpm-workspace.yaml `allowBuilds`, so a missing prebuild can never be
// masked by a silent source compile.
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND_BY_PLATFORM = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

const EVENT_TIMEOUT_MS = 5000;

function detectLibcSuffixes() {
  if (process.platform !== 'linux') {
    return [''];
  }
  // Report both candidates; whichever resolves is the one in use.
  return ['-glibc', '-musl'];
}

function resolvePrebuildPackage() {
  // Platform prebuilds are optional deps OF @parcel/watcher, so under pnpm's
  // strict layout they are only resolvable from @parcel/watcher's own
  // location, not from this package.
  const require = createRequire(import.meta.url);
  let watcherPackageJson;
  try {
    watcherPackageJson = require.resolve('@parcel/watcher/package.json');
  } catch {
    return null;
  }
  const fromWatcher = createRequire(watcherPackageJson);
  const candidates = detectLibcSuffixes().map(
    (suffix) => `@parcel/watcher-${process.platform}-${process.arch}${suffix}`
  );
  for (const name of candidates) {
    try {
      fromWatcher.resolve(`${name}/package.json`);
      return name;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// fail() exits synchronously, which skips async finally blocks — the temp
// root registers here so repeated packaged-app runs never accumulate dirs.
let cleanupRoot = null;

function fail(backend, code, message) {
  if (cleanupRoot) {
    rmSync(cleanupRoot, { force: true, recursive: true });
  }
  process.stdout.write(
    `${JSON.stringify({
      arch: process.arch,
      backend,
      error: { code, message },
      ok: false,
      platform: process.platform,
    })}\n`
  );
  process.exit(1);
}

const backend = BACKEND_BY_PLATFORM[process.platform];
if (!backend) {
  fail(null, 'unsupported-platform', `No parcel backend for ${process.platform}`);
}

const prebuildPackage = resolvePrebuildPackage();
if (!prebuildPackage) {
  fail(
    backend,
    'missing-prebuild',
    `No @parcel/watcher prebuild package resolved for ${process.platform}-${process.arch}`
  );
}

let watcher;
try {
  watcher = await import('@parcel/watcher');
} catch (error) {
  fail(backend, 'binding-load-failed', error instanceof Error ? error.message : String(error));
}

const root = await mkdtemp(join(tmpdir(), 'bst568-validate-'));
cleanupRoot = root;
try {
  const subscribeStart = performance.now();
  let sawEvent = () => undefined;
  const firstEvent = new Promise((resolve) => {
    sawEvent = resolve;
  });
  const subscription = await watcher.subscribe(
    root,
    (error) => {
      if (!error) {
        sawEvent();
      }
    },
    { backend }
  );
  const subscribeMs = performance.now() - subscribeStart;

  try {
    const eventStart = performance.now();
    await writeFile(join(root, 'probe.txt'), 'probe');
    await Promise.race([
      firstEvent,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`no event within ${EVENT_TIMEOUT_MS}ms`)),
          EVENT_TIMEOUT_MS
        )
      ),
    ]);
    const firstEventMs = performance.now() - eventStart;

    process.stdout.write(
      `${JSON.stringify({
        arch: process.arch,
        backend,
        firstEventMs: Math.round(firstEventMs * 10) / 10,
        ok: true,
        platform: process.platform,
        prebuildPackage,
        subscribeMs: Math.round(subscribeMs * 10) / 10,
      })}\n`
    );
  } finally {
    await subscription.unsubscribe();
  }
} catch (error) {
  fail(backend, 'subscribe-failed', error instanceof Error ? error.message : String(error));
} finally {
  await rm(root, { force: true, recursive: true });
}
