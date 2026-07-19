'use strict';

// BST-568 slice 4: packaged-app proof for the @parcel/watcher native binding.
// Loading the binding from the asar-unpacked path is the one thing dev-mode
// tests cannot prove. Runs under `ELECTRON_RUN_AS_NODE=1 electron` after
// `pnpm --filter @brainstrike/desktop run pack` (mirrors
// packages/secure-fs-native/test/packaged-smoke.cjs).

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const BACKEND_BY_PLATFORM = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

const desktopRoot = path.resolve(__dirname, '../../../apps/desktop');
const macDirectory = existsSync(path.join(desktopRoot, 'release/mac-arm64')) ? 'mac-arm64' : 'mac';
const resources =
  process.platform === 'darwin'
    ? path.join(desktopRoot, `release/${macDirectory}/BrainStrike Desktop.app/Contents/Resources`)
    : path.join(
        desktopRoot,
        `release/${process.platform === 'win32' ? 'win' : 'linux'}-unpacked/resources`
      );
const archive = path.join(resources, 'app.asar');
const unpackedWatcherDir = path.join(resources, 'app.asar.unpacked/node_modules/@parcel/watcher');

assert.equal(existsSync(archive), true, `Missing packaged archive: ${archive}`);
assert.equal(
  existsSync(unpackedWatcherDir),
  true,
  `Missing asar-unpacked @parcel/watcher: ${unpackedWatcherDir}`
);

const backend = BACKEND_BY_PLATFORM[process.platform];
assert.ok(backend, `Unsupported packaged-smoke platform: ${process.platform}`);

async function main() {
  const requireFromPackage = createRequire(path.join(archive, 'package.json'));
  const watcher = requireFromPackage('@parcel/watcher');

  const root = mkdtempSync(path.join(os.tmpdir(), 'bst568-packaged-'));
  try {
    let sawEvent = () => undefined;
    let sawError = () => undefined;
    const firstEvent = new Promise((resolve, reject) => {
      sawEvent = resolve;
      sawError = reject;
    });
    const subscription = await watcher.subscribe(
      root,
      (error) => {
        if (error) {
          sawError(error);
          return;
        }
        sawEvent();
      },
      { backend }
    );
    let timer = null;
    try {
      writeFileSync(path.join(root, 'probe.txt'), 'probe');
      await Promise.race([
        firstEvent,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('no packaged watcher event within 5s')), 5000);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      await subscription.unsubscribe();
    }
    process.stdout.write(
      `${JSON.stringify({ arch: process.arch, backend, ok: true, platform: process.platform })}\n`
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
