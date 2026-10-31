/**
 * Desktop E2E for local crash capture (BST-2351): a crashed renderer leaves a
 * minidump in the profile's Crashpad folder, and the diagnostics bridge the
 * thread debug pack reads lists it. The crash is a throwaway window's, so the
 * app's own window keeps running and the listing is read from it.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ElectronApplication, Page } from '@playwright/test';
import type { CrashDumpListing } from '../src/diagnostics/crash-dumps';
import { expect, test } from './fixtures/electron-fixture';

async function crashThrowawayRenderer(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ BrowserWindow }) => {
    const doomed = new BrowserWindow({ show: false });
    await doomed.loadURL('about:blank');
    const gone = new Promise<string>((resolve) => {
      doomed.webContents.once('render-process-gone', (_event, details) => resolve(details.reason));
    });
    doomed.webContents.forcefullyCrashRenderer();
    const goneReason = await gone;
    doomed.destroy();
    return goneReason;
  });
}

async function listedDumpNames(page: Page): Promise<unknown> {
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
}

test.describe('Crash dumps (desktop)', () => {
  test('a crashed renderer leaves a minidump the debug pack can name', async ({
    electronApp,
    window: page,
  }) => {
    expect(await crashThrowawayRenderer(electronApp.app)).not.toBe('clean-exit');
    await expect
      .poll(() => listedDumpNames(page), { timeout: 15_000 })
      .toEqual([expect.stringMatching(/\.dmp$/u)]);
  });

  test('factory reset deletes the minidumps and the next crash is still captured', async ({
    electronApp,
    window: page,
  }) => {
    test.skip(process.platform === 'win32', 'Factory reset is unavailable on Windows.');
    await crashThrowawayRenderer(electronApp.app);
    await expect
      .poll(() => listedDumpNames(page), { timeout: 15_000 })
      .toEqual([expect.stringMatching(/\.dmp$/u)]);
    const [before] = (await listedDumpNames(page)) as string[];

    // The reset replaces this document, so its answer never returns here: the
    // replacement document's load is the signal, as in the factory reset spec.
    await Promise.all([
      page.waitForEvent('load', { predicate: (loaded) => loaded.url() !== 'about:blank' }),
      page.evaluate(() => {
        void (
          window as unknown as {
            electronAPI?: { factoryReset?: { resetLocal: () => Promise<unknown> } };
          }
        ).electronAPI?.factoryReset?.resetLocal();
      }),
    ]);
    await expect.poll(() => listedDumpNames(page), { timeout: 15_000 }).toEqual([]);

    await crashThrowawayRenderer(electronApp.app);
    await expect
      .poll(() => listedDumpNames(page), { timeout: 15_000 })
      .toEqual([expect.stringMatching(/\.dmp$/u)]);
    expect(await listedDumpNames(page)).not.toContain(before);
  });
});
