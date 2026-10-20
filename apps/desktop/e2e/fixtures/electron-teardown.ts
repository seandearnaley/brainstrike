import { rm } from 'node:fs/promises';
import {
  attachFailureScreenshot,
  type FailureScreenshotTestInfo,
} from '../utils/failure-screenshot';
import type { ElectronHarness } from './electron-harness';

/** The `electron` fixture's teardown: the app it launched, its profile and its workspace. */
export async function tearDownElectronTest(
  harness: Pick<ElectronHarness, 'currentWindow' | 'dispose'>,
  testInfo: FailureScreenshotTestInfo,
  userDataDir: string | undefined,
  workspaceRoot: string
): Promise<void> {
  // Before the close, so its deadline never pays for the capture (BST-2239).
  await attachFailureScreenshot(harness.currentWindow(), testInfo);
  // Failed retirement keeps the disposable profile for the still-owned process.
  await harness.dispose();
  await removeElectronUserDataDir(userDataDir);
  await rm(workspaceRoot, { force: true, recursive: true });
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
