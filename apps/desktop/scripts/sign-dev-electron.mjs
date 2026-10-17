#!/usr/bin/env node
/**
 * Opt-in macOS install step: sign the development Electron.app with a stable
 * code-signing identity so Keychain grants survive Electron upgrades.
 *
 * Electron's macOS dist is ad-hoc signed, so its designated requirement is the
 * binary's cdhash. "Always Allow" on a Keychain prompt trusts that hash only:
 * every Electron version, including the ones other worktrees install, asks
 * again for every stored credential. A real identity makes the requirement
 * team-based, so one grant per credential lasts across upgrades and worktrees.
 *
 * Opt in by exporting BRAINSTRIKE_DEV_ELECTRON_SIGNING_IDENTITY with the full
 * identity name that `security find-identity -v -p codesigning` prints. Unset,
 * this is a no-op. Set, an identity that cannot sign fails the install.
 * Packaging is unaffected: electron-builder signs its own copy of Electron.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const SIGNING_IDENTITY_ENV = 'BRAINSTRIKE_DEV_ELECTRON_SIGNING_IDENTITY';

const execFileAsync = promisify(execFile);

export function electronAppBundlePath(executablePath) {
  const macOs = path.dirname(executablePath);
  const contents = path.dirname(macOs);
  const app = path.dirname(contents);
  if (
    path.basename(executablePath) !== 'Electron' ||
    path.basename(macOs) !== 'MacOS' ||
    path.basename(contents) !== 'Contents' ||
    path.extname(app) !== '.app'
  ) {
    throw new Error(`Expected a macOS Electron.app executable path, received ${executablePath}.`);
  }
  return app;
}

/** The whole bundle verifies strictly and its leaf authority is `identity`. */
async function isSignedBy(app, identity) {
  try {
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', app]);
  } catch {
    // Electron's stock ad-hoc signature fails strict verification; sign it.
    return false;
  }
  const { stderr } = await execFileAsync('codesign', ['--display', '--verbose=2', app]);
  const leaf = stderr.split('\n').find((line) => line.startsWith('Authority='));
  return leaf === `Authority=${identity}`;
}

export async function signDevElectron({
  env,
  platform,
  resolveElectronExecutable,
  isSignedBy,
  signApp,
}) {
  const identity = env[SIGNING_IDENTITY_ENV];
  if (!identity) {
    return 'not-opted-in';
  }
  if (platform !== 'darwin') {
    return 'not-macos';
  }
  const app = electronAppBundlePath(resolveElectronExecutable());
  if (await isSignedBy(app, identity)) {
    return 'already-signed';
  }
  try {
    await signApp({
      app,
      identity,
      // Local launches only: no hardened runtime, so unsigned native addons
      // still load without library validation, and no network timestamp.
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
      platform: 'darwin',
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
    });
  } catch (error) {
    throw new Error(
      `${SIGNING_IDENTITY_ENV} is "${identity}", but signing ${app} with it failed. ` +
        'Set it to a valid identity from `security find-identity -v -p codesigning`, or unset it.',
      { cause: error }
    );
  }
  return 'signed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  signDevElectron({
    env: process.env,
    isSignedBy,
    platform: process.platform,
    resolveElectronExecutable: () => require('electron'),
    signApp: async (options) => (await import('@electron/osx-sign')).signAsync(options),
  }).then(
    (status) => {
      if (status === 'signed' || status === 'already-signed') {
        console.log(`[sign-dev-electron] ${status}: ${process.env[SIGNING_IDENTITY_ENV]}`);
      }
    },
    (error) => {
      process.stderr.write(`[sign-dev-electron] ${error.message}\n`);
      if (error.cause instanceof Error) {
        process.stderr.write(`[sign-dev-electron] ${error.cause.message}\n`);
      }
      process.exitCode = 1;
    }
  );
}
