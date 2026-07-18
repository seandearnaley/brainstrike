/**
 * SCRATCH diagnostic spec (not for CI): does a mid-session added root SURVIVE
 * a restart? Seeds root #1, adds root #2 through the real Add Folder flow,
 * reloads the renderer (main-process storage persists — the restart proxy),
 * and checks whether both roots come back.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

function makeRootDir(label: string, fileCount: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `brainstrike-scratch-${label}-`));
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    const sub = i % 3 === 0 ? 'nested' : '.';
    writeFileSync(path.join(dir, sub, `${label}-${i}.ts`), `export const v${i} = ${i};\n`);
  }
  return dir;
}

let ROOT_ONE_DIR: string;
let ROOT_TWO_DIR: string;

test.beforeAll(() => {
  ROOT_ONE_DIR = makeRootDir('alpha', 4);
  ROOT_TWO_DIR = makeRootDir('bravo', 4);
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ROOT_TWO_DIR;
});

test.afterAll(() => {
  // biome-ignore lint/performance/noDelete: must actually unset
  delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  rmSync(ROOT_ONE_DIR, { force: true, recursive: true });
  rmSync(ROOT_TWO_DIR, { force: true, recursive: true });
});

async function dumpState(page: import('@playwright/test').Page): Promise<{
  markers: Record<string, boolean>;
  rootsList: string;
  sectionCount: number;
}> {
  return await page.evaluate(async () => {
    const storage = (
      globalThis as typeof globalThis & {
        electronAPI?: { storage?: { getItem?: (k: string) => Promise<string | null> } };
      }
    ).electronAPI?.storage;
    const rootsList = (await storage?.getItem?.('rootsList')) ?? '(unavailable)';
    const body = document.body.textContent ?? '';
    return {
      markers: { alpha: body.includes('alpha-1.ts'), bravo: body.includes('bravo-1.ts') },
      rootsList,
      sectionCount: document.querySelectorAll('[data-testid="root-section-header"]').length,
    };
  });
}

test.describe('Scratch: added-root persistence', () => {
  test('@scratch-root-persistence a mid-session added root survives a renderer restart', async ({
    window: page,
  }) => {
    test.setTimeout(4 * 60 * 1000);

    await page.evaluate(
      async ({ rootOne }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', rootOne);
        await storage.setItem(
          'rootsList',
          JSON.stringify([{ addedAt: 1_800_000_000_000, path: rootOne, rootId: 'scratch-alpha' }])
        );
        localStorage.setItem(
          'background-indexing-preferences.v1',
          JSON.stringify({
            state: {
              enabled: false,
              indexingPolicyPreset: 'full-root',
              managedCollectionId: null,
              mode: 'root-folder-cache',
              paused: true,
            },
            version: 4,
          })
        );
      },
      { rootOne: ROOT_ONE_DIR }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'scratch-persistence-seeded');
    await expect(page.getByText('alpha-1.ts').first()).toBeVisible({ timeout: 60_000 });

    // Add root #2 through the real flow.
    const addFolderButton = page.getByRole('button', { name: 'Add Folder to Workspace' });
    await expect(addFolderButton).toBeVisible({ timeout: 30_000 });
    await addFolderButton.click();
    await expect(page.getByText('bravo-1.ts').first()).toBeVisible({ timeout: 60_000 });

    const beforeRestart = await dumpState(page);
    // eslint-disable-next-line no-console
    console.log(`[scratch] BEFORE restart: ${JSON.stringify(beforeRestart)}`);
    expect(beforeRestart.rootsList).toContain(ROOT_TWO_DIR);

    // Restart proxy: renderer reload — main-process storage persists.
    await reloadRenderer(page, 'scratch-persistence-restart');

    let afterRestart = await dumpState(page);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(2000);
      afterRestart = await dumpState(page);
      // eslint-disable-next-line no-console
      console.log(
        `[scratch] AFTER restart (t+${(attempt + 1) * 2}s): ${JSON.stringify(afterRestart)}`
      );
      if (afterRestart.markers['alpha'] && afterRestart.markers['bravo']) {
        break;
      }
    }

    await page.screenshot({ path: 'scratch-root-persistence.png' });
    expect(afterRestart.rootsList).toContain(ROOT_TWO_DIR);
    expect(afterRestart.markers['alpha'], 'seeded root alpha should restore').toBe(true);
    expect(afterRestart.markers['bravo'], 'added root bravo should restore').toBe(true);
  });
});
