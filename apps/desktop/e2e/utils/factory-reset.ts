import { once } from 'node:events';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ElectronHarness } from '../fixtures/electron-harness';
import { HomePage } from '../page-objects/home-page';
import { SettingsPage } from '../page-objects/settings-page';
import type { ElectronAppContext } from './electron-helpers.mts';

/**
 * Confirms Settings › Factory Reset. Main records the reset and quits through its normal quit;
 * under E2E it does not relaunch itself, so this starts the app again on the same userData, which
 * finishes the reset before it opens anything. Resolves with the fresh app.
 */
export async function factoryResetAndRelaunch(
  electron: ElectronHarness,
  page: Page,
  onAppAcquired?: (app: ElectronApplication) => void
): Promise<ElectronAppContext> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
  await page.evaluate(() => {
    const original = window.confirm;
    window.confirm = () => {
      window.confirm = original;
      return true;
    };
  });
  const clicked = performance.now();
  await electron.endOutOfBand(async (main) => {
    const exited = once(main, 'exit');
    await page.getByTestId('factory-reset-button').click();
    const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    if (code !== 0 || signal !== null) {
      throw new Error(`Factory reset quit uncleanly (code=${code}, signal=${signal})`);
    }
  });
  const quit = performance.now();
  const relaunched = await electron.restart(onAppAcquired);
  // Phase timings for the run's log: confirm to exit, then exit to the fresh app's first window.
  console.log('FACTORY-RESET-PHASES', {
    quitMs: Math.round(quit - clicked),
    relaunchMs: Math.round(performance.now() - quit),
  });
  return relaunched;
}
