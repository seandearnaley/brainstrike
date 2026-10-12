'use strict';

// BST-568 slice 4: packaged-app proof for the @parcel/watcher native binding.
// Loading the binding from the asar-unpacked path is the one thing dev-mode
// tests cannot prove. Runs under `ELECTRON_RUN_AS_NODE=1 electron` after
// `pnpm --filter @brainstrike/desktop run pack` (mirrors
// packages/secure-fs-native/test/packaged-smoke.cjs).

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const BACKEND_BY_PLATFORM = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

const desktopRoot = path.resolve(__dirname, '../../../apps/desktop');
if (
  !(
    ['arm64', 'x64'].includes(process.arch) &&
    ['darwin', 'linux', 'win32'].includes(process.platform)
  )
) {
  throw new Error(`Unsupported packaged native target: ${process.platform}/${process.arch}`);
}
const macDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const architectureSuffix = process.arch === 'arm64' ? '-arm64' : '';
const resources =
  process.platform === 'darwin'
    ? path.join(desktopRoot, `release/${macDirectory}/BrainStrike Desktop.app/Contents/Resources`)
    : path.join(
        desktopRoot,
        `release/${process.platform === 'win32' ? 'win' : 'linux'}${architectureSuffix}-unpacked/resources`
      );
const archive = path.join(resources, 'app.asar');
const packagedFileSystemManifest = path.join(
  archive,
  'node_modules/@brainstrike/file-system/package.json'
);
// asarUnpack is deliberately limited to `**/node_modules/@parcel/**/*.node`
// (mirroring secure-fs-native): whole-directory unpack globs corrupt the asar
// under pnpm's symlinked layout (observed live: picomatch/package.json entry
// containing JS source, micromatch missing entirely).
const unpackedParcelScope = path.join(resources, 'app.asar.unpacked/node_modules/@parcel');

function findNodeBinding(dir) {
  if (!existsSync(dir)) {
    return null;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findNodeBinding(full);
      if (nested) {
        return nested;
      }
    } else if (entry.name.endsWith('.node')) {
      return full;
    }
  }
  return null;
}

assert.equal(existsSync(archive), true, `Missing packaged archive: ${archive}`);
assert.equal(
  existsSync(packagedFileSystemManifest),
  true,
  `Missing packaged file-system manifest: ${packagedFileSystemManifest}`
);
const unpackedBinding = findNodeBinding(unpackedParcelScope);
assert.ok(
  unpackedBinding,
  `No asar-unpacked @parcel .node binding found under: ${unpackedParcelScope}`
);

const backend = BACKEND_BY_PLATFORM[process.platform];
assert.ok(backend, `Unsupported packaged-smoke platform: ${process.platform}`);

async function main() {
  // Resolve from the package that owns this dependency, exactly like
  // @brainstrike/file-system/electron does at runtime. Resolving from the app
  // root would accidentally require electron-builder to hoist this transitive
  // dependency even though a nested pnpm layout is valid.
  const requireFromFileSystem = createRequire(packagedFileSystemManifest);
  const watcher = requireFromFileSystem('@parcel/watcher');

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
