import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { IndexSearchCapability } from '../../../../packages/indexing-contract/src/indexer-client';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import {
  assertTextInferenceInactive,
  createCandidateSession,
  readNativeSnapshot,
  waitForTextIndex,
} from './candidate';
import { resetFromUi } from './factory-reset-confirmation';
import { configureNativeText } from './native-settings';

async function search(context: ElectronAppContext, term = 'DisposerStack'): Promise<unknown> {
  const page = context.window;
  await page.getByTestId('search-tab-trigger').click();
  const panel = page.getByTestId('explorer-search-panel-search');
  await expect(panel.getByRole('button', { exact: true, name: 'Text' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await panel.getByPlaceholder('Search workspace').fill(term);
  await panel.getByPlaceholder('Search workspace').press('Enter');
  await expect(panel.getByText('disposer-stack.ts', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.getByTestId('workspace-search-results-error')).toHaveCount(0);
  const arms = await page.evaluate(async (text) => {
    const api = (window as typeof window & { indexSearch: IndexSearchCapability }).indexSearch;
    const status = await api.status();
    if (status.kind !== 'ready') {
      throw new Error(status.reason);
    }
    const scope = { limit: 100, rootIds: status.authorizedRootIds };
    return {
      bm25: await api.search({ ...scope, mode: 'bm25', text }),
      grep: await api.grep({ ...scope, caseSensitive: false, isRegex: false, pattern: text }),
    };
  }, term);
  for (const arm of [arms.bm25, arms.grep]) {
    expect(arm.hits.some((hit) => hit.relativePath === 'disposer-stack.ts')).toBe(true);
    expect(arm.embedding).toEqual({ indexMode: 'text-only' });
    for (const hit of arm.hits) {
      expect(hit.contentHash).toBe(createHash('sha256').update(hit.content).digest('hex'));
      expect(hit.startLine).toBeGreaterThan(0);
      expect(hit.endLine).toBeGreaterThanOrEqual(hit.startLine);
      expect(hit.chunkIndex).not.toBeNull();
      expect(hit.startOffset).not.toBeNull();
    }
  }
  assertTextInferenceInactive(await readNativeSnapshot(context));
  return arms;
}

test('real canonical TEXT picker, incremental publication/removal, reopen and Factory Reset', async () => {
  const session = await createCandidateSession('text');
  const corpus = path.join(session.runDir, 'corpus');
  await cp(path.join(import.meta.dirname, 'corpus'), corpus, { recursive: true });
  const manifest: { files: { relativePath: string; sha256: string; bytes: number }[] } = JSON.parse(
    await readFile(path.join(import.meta.dirname, 'corpus-manifest.json'), 'utf8')
  );
  for (const file of manifest.files) {
    const content = await readFile(path.join(corpus, file.relativePath));
    expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256);
    expect(content.length).toBe(file.bytes);
  }
  let context: ElectronAppContext | undefined;
  try {
    context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
    assertTextInferenceInactive(await readNativeSnapshot(context));
    await configureNativeText(context);
    await context.window.getByTestId('select-root-button').click();
    const initial = await waitForTextIndex(context, 3);
    await session.record('canonical-text', {
      arms: await search(context),
      manifest,
      snapshot: initial,
    });
    const names = await readdir(session.userDataDir, { recursive: true });
    const indexPaths = names.filter((name) => name.endsWith('index.sqlite'));
    expect(indexPaths).toHaveLength(1);
    const relativeIndexPath = indexPaths[0];
    if (!relativeIndexPath) {
      throw new Error('Native index path is missing.');
    }
    const indexPath = path.join(session.userDataDir, relativeIndexPath);
    const changed = path.join(corpus, 'disposer-stack.ts');
    const original = await readFile(changed, 'utf8');
    await writeFile(
      changed,
      `${original}\nexport function M2IncrementalWitness(): number { return 1925; }\n`
    );
    await expect
      .poll(
        async () => {
          if (!context) {
            throw new Error('Candidate closed.');
          }
          return await context.window.evaluate(async () => {
            const api = (window as typeof window & { indexSearch: IndexSearchCapability })
              .indexSearch;
            const status = await api.status();
            if (status.kind !== 'ready') {
              return false;
            }
            const result = await api.search({
              limit: 100,
              mode: 'bm25',
              rootIds: status.authorizedRootIds,
              text: 'M2IncrementalWitness',
            });
            return result.hits.some((hit) => hit.relativePath === 'disposer-stack.ts');
          });
        },
        { timeout: 90_000 }
      )
      .toBe(true);
    await session.record('incremental-update', await search(context, 'M2IncrementalWitness'));
    await rm(path.join(corpus, 'bridges.ts'));
    await session.record('incremental-removal', await waitForTextIndex(context, 2));
    await session.close();
    context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
    const reopened = await waitForTextIndex(context, 2);
    expect(reopened.status.kind === 'ready' && reopened.status.storeId).toBe(
      initial.status.kind === 'ready' && initial.status.storeId
    );
    await session.record('persisted-profile-reopen', {
      arms: await search(context, 'M2IncrementalWitness'),
      snapshot: reopened,
    });
    await new HomePage(context.window).openSettings();
    await new SettingsPage(context.window).openCategory(/Factory Reset/i, 'factory-reset');
    await resetFromUi(context.window, session.record);
    await expect(context.window.getByTestId('select-root-button')).toBeVisible({ timeout: 30_000 });
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(stat(`${indexPath}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await session.record('factory-reset', await readNativeSnapshot(context));
    await session.close();
    context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
    await configureNativeText(context);
    await context.window.getByTestId('select-root-button').click();
    const fresh = await waitForTextIndex(context, 2);
    expect(fresh.status.kind === 'ready' && fresh.status.storeId).not.toBe(
      initial.status.kind === 'ready' && initial.status.storeId
    );
    await session.record('reset-profile-reindex', { arms: await search(context), snapshot: fresh });
    await context.window.screenshot({ path: path.join(session.runDir, 'reindexed.png') });
  } catch (error) {
    await session.record('failure', { message: String(error) });
    if (context) {
      await context.window.screenshot({ path: path.join(session.runDir, 'failure.png') });
    }
    throw error;
  } finally {
    await session.close();
  }
});
