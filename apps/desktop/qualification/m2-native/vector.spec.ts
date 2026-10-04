import { cp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import {
  createCandidateSession,
  observeNativeSnapshot,
  readNativeSnapshot,
  waitForTextIndex,
} from './candidate';
import { resetFromUi } from './factory-reset-confirmation';
import { nativeBuildComplete } from './native-benchmark';
import { configureNativeText } from './native-settings';
import { assertActualVectorWorker, configureVectorProfile } from './vector-profile';

test('explicit native vector publication, semantic query and separate Factory Reset', async () => {
  test.setTimeout(600_000);
  const session = await createCandidateSession('vector-profile');
  const corpus = path.join(session.runDir, 'corpus');
  await cp(path.join(import.meta.dirname, 'corpus'), corpus, { recursive: true });
  try {
    const context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
    await configureNativeText(context);
    await context.window.getByTestId('select-root-button').click();
    await waitForTextIndex(context, 3);
    const configured = await configureVectorProfile(context);
    if (
      configured.status.kind !== 'ready' ||
      configured.status.embedding.indexMode !== 'vector-configured'
    ) {
      throw new Error('Vector profile is unavailable.');
    }
    const rootId = configured.status.authorizedRootIds[0];
    if (!rootId) {
      throw new Error('Authorized root is unavailable.');
    }
    const scope = {
      files: 3,
      mode: 'vector' as const,
      profile: configured.status.embedding.profile,
      rootId,
      storeId: configured.status.storeId,
    };
    await expect
      .poll(
        async () => {
          const snapshot = await observeNativeSnapshot(context);
          return (
            snapshot !== null && nativeBuildComplete(snapshot.status, snapshot.coverage, scope)
          );
        },
        {
          message: 'Actual document inference must complete native vector coverage',
          timeout: 480_000,
        }
      )
      .toBe(true);
    const complete = await readNativeSnapshot(context);
    assertActualVectorWorker(complete);
    await session.record('complete-vector-publication', complete);
    await context.window.getByTestId('search-tab-trigger').click();
    const panel = context.window.getByTestId('explorer-search-panel-search');
    await panel.getByRole('button', { exact: true, name: 'Semantic' }).click();
    await panel.getByPlaceholder('Search workspace').fill('DisposerStack');
    await panel.getByPlaceholder('Search workspace').press('Enter');
    await expect(panel.getByTestId('workspace-search-results-error')).toHaveCount(0);
    await expect(panel.getByText('disposer-stack.ts', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await session.record('actual-query-inference', await readNativeSnapshot(context));
    const home = new HomePage(context.window);
    await home.openSettings();
    const settings = new SettingsPage(context.window);
    const indexPaths = (await readdir(session.userDataDir, { recursive: true })).filter((name) =>
      name.endsWith('index.sqlite')
    );
    expect(indexPaths).toHaveLength(1);
    const indexPath = indexPaths[0];
    if (!indexPath) {
      throw new Error('Native index file is unavailable.');
    }
    await home.openSettings();
    await settings.openCategory(/Factory Reset/i, 'factory-reset');
    await resetFromUi(context.window, session.record);
    await expect(context.window.getByTestId('select-root-button')).toBeVisible({ timeout: 30_000 });
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(
        stat(path.join(session.userDataDir, `${indexPath}${suffix}`))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect
      .poll(() =>
        context.window.evaluate(async () => {
          const bridge = (
            window as typeof window & {
              electronAPI?: { storage: { getItem(key: string): Promise<string | null> } };
            }
          ).electronAPI;
          if (!(bridge && 'storage' in bridge)) {
            throw new Error('Renderer storage capability is unavailable.');
          }
          const stored = await bridge.storage.getItem('background-indexing-preferences.v1');
          if (stored === null) {
            return null;
          }
          const state = JSON.parse(stored).state;
          return state.nativeIndexMode === null && state.nativeLocalSelection === null
            ? null
            : state;
        })
      )
      .toBeNull();
    await session.record(
      'reset-clears-vector-preference-and-index',
      await readNativeSnapshot(context)
    );
  } finally {
    await session.close();
  }
});
