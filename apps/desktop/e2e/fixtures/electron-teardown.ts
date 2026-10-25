import { rm } from 'node:fs/promises';
import {
  attachFailureScreenshot,
  type FailureScreenshotTestInfo,
} from '../utils/failure-screenshot';
import type { ElectronHarness } from './electron-harness';

/** The `electron` fixture's teardown: the app it launched, its profile, then its folders. */
export async function tearDownElectronTest(
  harness: Pick<ElectronHarness, 'currentWindow' | 'dispose'>,
  testInfo: FailureScreenshotTestInfo,
  userDataDir: string | undefined,
  directories: readonly string[]
): Promise<void> {
  try {
    // Before the close, so its deadline never pays for the capture (BST-2239).
    await attachFailureScreenshot(harness.currentWindow(), testInfo);
  } finally {
    // A capture that fails still retires the app first, then fails this teardown.
    // Failed retirement keeps the disposable profile for the still-owned process.
    await harness.dispose();
    await removeElectronUserDataDir(userDataDir);
    // The app is closed, so Windows lets its folders go.
    for (const directory of directories) {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

async function removeElectronUserDataDir(userDataDir: string | undefined): Promise<void> {
  if (!userDataDir) {
    return;
  }

  try {
    await rm(userDataDir, { force: true, recursive: true });
  } catch (error) {
    console.warn('Failed to remove Electron userData directory after fixture teardown:', {
      error,
      userDataDir,
    });
  }
}
