import { mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { targetAlternate, verifyAddonArchs } from '../../../scripts/verify-macos-addon-archs.mjs';

// The release smoke gate for packaged macOS apps: every addon the app can load
// must contain the DMG's arch, across the volume name's spaces.

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((dir) => fsPromises.rm(dir, { force: true, recursive: true }))
  );
});

async function app(addons: Record<string, string[] | null>) {
  const volume = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'BrainStrike Desktop 0.1.0 '));
  cleanupPaths.push(volume);
  const bundle = path.join(volume, 'BrainStrike Desktop.app');
  const unpacked = path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked');
  const archs = new Map<string, string[] | null>();
  for (const [relative, value] of Object.entries(addons)) {
    const file = path.join(unpacked, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    archs.set(file, value);
  }
  return { archsOf: (file: string) => archs.get(file) ?? null, bundle };
}

describe('verify-macos-addon-archs', () => {
  it('accepts target-arch addons, other-OS prebuilds and alternates whose target sibling exists', async () => {
    const { archsOf, bundle } = await app({
      'node_modules/@brainstrike/secure-fs-native/build/Release/secure_fs_native.node': ['arm64'],
      'node_modules/better-sqlite3/prebuilds/darwin-arm64.node': ['arm64'],
      'node_modules/better-sqlite3/prebuilds/darwin-x64.node': ['x86_64'],
      'node_modules/better-sqlite3/prebuilds/linux-x64.node': null,
      'node_modules/node-pty/prebuilds/darwin-arm64/pty.node': ['arm64'],
      'node_modules/node-pty/prebuilds/darwin-x64/pty.node': ['x86_64'],
    });
    expect(verifyAddonArchs(bundle, 'arm64', archsOf)).toEqual({ checked: 5, failures: [] });
  });

  it('names every addon an x64 app cross-built on arm64 cannot load', async () => {
    const { archsOf, bundle } = await app({
      'node_modules/@brainstrike/secure-fs-native/build/Release/secure_fs_native.node': ['arm64'],
      'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node': ['arm64'],
      'node_modules/better-sqlite3/prebuilds/darwin-arm64.node': ['arm64'],
      'node_modules/better-sqlite3/prebuilds/darwin-x64.node': ['x86_64'],
      'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node': ['arm64'],
    });
    expect(verifyAddonArchs(bundle, 'x64', archsOf).failures).toEqual([
      'node_modules/@brainstrike/secure-fs-native/build/Release/secure_fs_native.node is arm64, not x86_64',
      'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node is arm64, not x86_64, and node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node is missing',
      'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node is arm64, not x86_64, and node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node is missing',
    ]);
  });

  it('maps only a whole darwin arch segment onto the target', () => {
    expect(targetAlternate('/a/darwin-arm64/x.node', 'x64', 'arm64')).toBe('/a/darwin-x64/x.node');
    expect(targetAlternate('/a/darwin/arm64/x.node', 'x64', 'arm64')).toBe('/a/darwin/x64/x.node');
    expect(targetAlternate('/a/keyring.darwin-arm64.node', 'x64', 'arm64')).toBe(
      '/a/keyring.darwin-x64.node'
    );
    expect(targetAlternate('/a/darwin-arm64e/x.node', 'x64', 'arm64')).toBeNull();
    expect(targetAlternate('/a/linux-arm64.node', 'x64', 'arm64')).toBeNull();
  });
});
