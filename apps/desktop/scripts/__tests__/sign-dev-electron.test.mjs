import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  electronAppBundlePath,
  SIGNING_IDENTITY_ENV,
  signDevElectron,
} from '../sign-dev-electron.mjs';

// Run directly: node --test apps/desktop/scripts/__tests__/sign-dev-electron.test.mjs
// (the desktop vitest config excludes scripts; see measure-boot.test.mjs).

const IDENTITY = 'Developer ID Application: Example Owner (TEAMID1234)';
const EXECUTABLE = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const APP = '/repo/node_modules/electron/dist/Electron.app';

function fakes({ signedBy = null, signError } = {}) {
  const calls = { resolve: 0, sign: [], signedByChecks: [] };
  return {
    calls,
    deps: {
      isSignedBy: async (app, identity) => {
        calls.signedByChecks.push({ app, identity });
        return signedBy === identity;
      },
      resolveElectronExecutable: () => {
        calls.resolve += 1;
        return EXECUTABLE;
      },
      signApp: async (options) => {
        calls.sign.push(options);
        if (signError) {
          throw signError;
        }
      },
    },
  };
}

test('does nothing unless the identity variable opts in', async () => {
  for (const env of [{}, { [SIGNING_IDENTITY_ENV]: '' }]) {
    const { calls, deps } = fakes();
    assert.equal(await signDevElectron({ ...deps, env, platform: 'darwin' }), 'not-opted-in');
    assert.equal(calls.resolve, 0);
    assert.equal(calls.sign.length, 0);
  }
});

test('does nothing off macOS even when opted in', async () => {
  const { calls, deps } = fakes();
  const env = { [SIGNING_IDENTITY_ENV]: IDENTITY };
  assert.equal(await signDevElectron({ ...deps, env, platform: 'linux' }), 'not-macos');
  assert.equal(calls.resolve, 0);
  assert.equal(calls.sign.length, 0);
});

test('keeps an Electron.app already signed by the opted-in identity', async () => {
  const { calls, deps } = fakes({ signedBy: IDENTITY });
  const env = { [SIGNING_IDENTITY_ENV]: IDENTITY };
  assert.equal(await signDevElectron({ ...deps, env, platform: 'darwin' }), 'already-signed');
  assert.deepEqual(calls.signedByChecks, [{ app: APP, identity: IDENTITY }]);
  assert.equal(calls.sign.length, 0);
});

test('signs the ad-hoc Electron.app as a local, non-hardened, untimestamped build', async () => {
  const { calls, deps } = fakes();
  const env = { [SIGNING_IDENTITY_ENV]: IDENTITY };
  assert.equal(await signDevElectron({ ...deps, env, platform: 'darwin' }), 'signed');
  assert.equal(calls.sign.length, 1);
  const [options] = calls.sign;
  assert.equal(options.app, APP);
  assert.equal(options.identity, IDENTITY);
  assert.equal(options.platform, 'darwin');
  // The identity must be validated against the keychain: a missing one fails.
  assert.notEqual(options.identityValidation, false);
  assert.equal(options.preAutoEntitlements, false);
  assert.equal(options.preEmbedProvisioningProfile, false);
  assert.deepEqual(options.optionsForFile(`${APP}/Contents/MacOS/Electron`), {
    hardenedRuntime: false,
    timestamp: 'none',
  });
});

test('fails loudly, naming the variable, when the identity cannot sign', async () => {
  const { deps } = fakes({ signError: new Error('No identity found for signing.') });
  const env = { [SIGNING_IDENTITY_ENV]: IDENTITY };
  await assert.rejects(signDevElectron({ ...deps, env, platform: 'darwin' }), (error) => {
    assert.match(error.message, new RegExp(SIGNING_IDENTITY_ENV));
    assert.match(error.message, /Example Owner \(TEAMID1234\)/);
    assert.match(error.cause.message, /No identity found for signing/);
    return true;
  });
});

test('resolves the bundle only from an Electron.app executable path', () => {
  assert.equal(electronAppBundlePath(EXECUTABLE), APP);
  assert.throws(() => electronAppBundlePath('/repo/node_modules/electron/dist/electron'));
  assert.throws(() => electronAppBundlePath('/repo/Electron.app/Contents/Resources/Electron'));
});

test('the install step exits non-zero for an identity missing from the keychain', {
  skip: process.platform !== 'darwin' && 'macOS only',
}, () => {
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../sign-dev-electron.mjs'
  );
  // osx-sign looks the identity up before it signs anything, so this
  // touches neither the keychain nor the installed Electron.app.
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [SIGNING_IDENTITY_ENV]: 'Developer ID Application: Brainstrike Missing Identity (0000000000)',
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(SIGNING_IDENTITY_ENV));
  assert.match(result.stderr, /No identity found for signing/);
});
