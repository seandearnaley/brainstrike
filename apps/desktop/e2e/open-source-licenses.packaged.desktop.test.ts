// The packaged app carries its third-party notices outside app.asar, where
// Help › Open-Source Licenses opens them (BST-2358). The test reads the file
// from its own process, as the app the shell starts would.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  expectNoticesNameShippedPackages,
  openSourceLicensesFromMenu,
} from './utils/open-source-licenses';
import { closePackagedDesktop, launchPackagedDesktop } from './utils/packaged-electron';

test('Help › Open-Source Licenses opens the packaged notices @packaged', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-licenses-packaged-'));
  try {
    const context = await launchPackagedDesktop({ userDataDir });
    try {
      const opened = await openSourceLicensesFromMenu(context.app);
      expect(opened).toMatch(/THIRD-PARTY-NOTICES\.txt$/u);
      expectNoticesNameShippedPackages(await readFile(opened ?? '', 'utf8'));
    } finally {
      await closePackagedDesktop(context);
    }
  } finally {
    await rm(userDataDir, { force: true, recursive: true });
  }
});
