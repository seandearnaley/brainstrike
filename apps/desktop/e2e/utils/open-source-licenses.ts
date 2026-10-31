import { expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';

/**
 * Pick Help › Open-Source Licenses and answer the path main asks the shell to
 * open, or null when the menu has no such item. Opening the file would start
 * another app, so the shell's openPath records the request for the click.
 */
export async function openSourceLicensesFromMenu(app: ElectronApplication): Promise<string | null> {
  return await app.evaluate(async ({ Menu, shell }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('help-open-source-licenses');
    if (!item) {
      return null;
    }
    const openPath = shell.openPath;
    try {
      const requested = new Promise<string>((resolve) => {
        shell.openPath = (target) => {
          resolve(target);
          return Promise.resolve('');
        };
      });
      item.click();
      return await requested;
    } finally {
      shell.openPath = openPath;
    }
  });
}

/**
 * The notices carry the hand-kept Python runtime entry, a package only the
 * renderer bundle inlines, a packed package and one that is both.
 */
export function expectNoticesNameShippedPackages(notices: string): void {
  expect(notices).toContain('## CPython (via python-build-standalone)');
  const lines = notices.split('\n');
  for (const name of ['@assistant-ui/react', 'better-sqlite3', 'react']) {
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${name} \\d`, 'u')));
  }
}
