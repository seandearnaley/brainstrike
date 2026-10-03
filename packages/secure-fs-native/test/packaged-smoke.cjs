'use strict';

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

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
const binding = path.join(
  resources,
  'app.asar.unpacked/node_modules/@brainstrike/secure-fs-native/build/Release/secure_fs_native.node'
);

assert.equal(existsSync(archive), true, `Missing packaged archive: ${archive}`);
assert.equal(existsSync(binding), true, `Missing unpacked native binding: ${binding}`);

const requireFromPackage = createRequire(path.join(archive, 'package.json'));
const { SecureRoot } = requireFromPackage('@brainstrike/secure-fs-native');
const root = new SecureRoot(resources);
root.close();
