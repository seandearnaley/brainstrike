/**
 * Desktop E2E for local crash capture (BST-2351): a crashed renderer leaves a
 * minidump in the profile's Crashpad folder, and the diagnostics bridge the
 * thread debug pack reads lists it. The crash is a throwaway window's, so the
 * app's own window keeps running and the listing is read from it.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { CrashDumpListing } from '../src/diagnostics/crash-dumps';
import { expect, test } from './fixtures/electron-fixture';

test.describe('Crash dumps (desktop)', () => {
  test('a crashed renderer leaves a minidump the debug pack can name', async ({
    electronApp,
    window: page,
  }) => {
    const app = electronApp.app;
    const reason = await app.evaluate(async ({ BrowserWindow }) => {
      const doomed = new BrowserWindow({ show: false });
      await doomed.loadURL('about:blank');
      const gone = new Promise<string>((resolve) => {
        doomed.webContents.once('render-process-gone', (_event, details) =>
          resolve(details.reason)
        );
      });
      doomed.webContents.forcefullyCrashRenderer();
      const goneReason = await gone;
      doomed.destroy();
      return goneReason;
    });
    expect(reason).not.toBe('clean-exit');

    await expect
      .poll(
        async () => {
          const result = await page.evaluate(() =>
            (
              window as unknown as {
                desktopDiagnostics?: {
                  listCrashDumps: () => Promise<BoundaryResult<CrashDumpListing>>;
                };
              }
            ).desktopDiagnostics?.listCrashDumps()
          );
          return result?.ok ? result.value.dumps.map((dump) => dump.name) : result;
        },
        { timeout: 15_000 }
      )
      .toEqual([expect.stringMatching(/\.dmp$/u)]);
  });
});
