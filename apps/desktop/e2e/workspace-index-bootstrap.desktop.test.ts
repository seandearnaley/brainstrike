import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';

interface WorkspaceIndexRow {
  readonly dimensions: number;
  readonly id: string;
  readonly model_id: string;
  readonly model_key: string;
  readonly name: string;
  readonly system_role: 'workspace-index';
}

async function openSearchIndexingSettings(args: { homePage: HomePage; page: Page }): Promise<void> {
  await args.homePage.openSettings();
  await args.page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(args.page.getByTestId('settings-category-search-indexing')).toBeVisible({
    timeout: 15_000,
  });
}

async function readWorkspaceIndexRows(page: Page): Promise<WorkspaceIndexRow[]> {
  return await page.evaluate(async () => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[]
            ) => Promise<{ rows: Record<string, unknown>[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Desktop DB query bridge is unavailable.');
    }

    const result = await api.db.query(
      `SELECT id, name, model_id, model_key, dimensions, system_role
       FROM embedding_sets
       WHERE system_role = $1
       ORDER BY created_at ASC`,
      ['workspace-index']
    );
    return result.rows as WorkspaceIndexRow[];
  });
}

test.describe('Workspace Index bootstrap (desktop)', () => {
  test('creates and binds the protected workspace index for a fresh profile', async ({
    electron,
  }) => {
    const { window } = await electron.ensureContext();
    const homePage = new HomePage(window);

    await openSearchIndexingSettings({ homePage, page: window });

    await expect(window.getByRole('switch', { name: 'Workspace Index' })).toBeChecked({
      timeout: 15_000,
    });

    await expect
      .poll(async () => await readWorkspaceIndexRows(window), {
        timeout: 15_000,
        message: 'Expected first run to create exactly one protected Workspace Index.',
      })
      .toMatchObject([
        {
          dimensions: 384,
          model_id: 'Xenova/all-MiniLM-L6-v2',
          model_key: 'local::Xenova/all-MiniLM-L6-v2',
          name: 'Workspace Index',
          system_role: 'workspace-index',
        },
      ]);

    const managedCollectionTrigger = window.locator('#managed-cache-collection');
    await expect(managedCollectionTrigger).toContainText('Workspace Index', {
      timeout: 15_000,
    });
    await expect(window.getByText(/Current managed collection:\s*Workspace Index/)).toBeVisible({
      timeout: 15_000,
    });
  });
});
