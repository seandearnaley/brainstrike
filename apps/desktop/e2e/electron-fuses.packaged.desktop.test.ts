// Packaged builds carry Electron's fuses as package.json's `electronFuses` sets
// them (BST-2357; apps/desktop/SECURITY.md). The wire is read from the packaged
// executable itself, the binary a user runs, and the app must still start with
// them: its renderer loads from app.asar over `brainstrike-app://`, never from
// `file://`.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { expect, test } from '@playwright/test';
import {
  closePackagedDesktop,
  launchPackagedDesktop,
  packagedDesktopExecutablePath,
} from './utils/packaged-electron';

test('the packaged app starts with the fuses package.json sets @packaged', async () => {
  const wire = await getCurrentFuseWire(packagedDesktopExecutablePath());
  const state = (fuse: FuseV1Options): string => {
    if (wire[fuse] === FuseState.ENABLE) {
      return 'on';
    }
    return wire[fuse] === FuseState.DISABLE ? 'off' : 'unset';
  };
  expect({
    asarIntegrity: state(FuseV1Options.EnableEmbeddedAsarIntegrityValidation),
    cookieEncryption: state(FuseV1Options.EnableCookieEncryption),
    fileProtocolExtraPrivileges: state(FuseV1Options.GrantFileProtocolExtraPrivileges),
    nodeCliInspect: state(FuseV1Options.EnableNodeCliInspectArguments),
    nodeOptions: state(FuseV1Options.EnableNodeOptionsEnvironmentVariable),
    onlyLoadAppFromAsar: state(FuseV1Options.OnlyLoadAppFromAsar),
    runAsNode: state(FuseV1Options.RunAsNode),
  }).toEqual({
    asarIntegrity: 'on',
    cookieEncryption: 'on',
    fileProtocolExtraPrivileges: 'off',
    // The agent host's Node children, corporate CA certificates and the
    // packaged lanes' Playwright attach need these (SECURITY.md).
    nodeCliInspect: 'on',
    nodeOptions: 'on',
    onlyLoadAppFromAsar: 'on',
    runAsNode: 'on',
  });

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-fuses-packaged-'));
  try {
    const context = await launchPackagedDesktop({ userDataDir });
    try {
      // The startup card in index.html stays until the bundled renderer mounts.
      await expect(context.window.locator('.bs-startup-shell')).toBeHidden({ timeout: 60_000 });
    } finally {
      await closePackagedDesktop(context);
    }
  } finally {
    await rm(userDataDir, { force: true, recursive: true });
  }
});
