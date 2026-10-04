import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import {
  type ElectronAppContext,
  getBufferedElectronOutput,
} from '../../e2e/utils/electron-helpers.mts';
import { createCandidateSession, observeInferenceStatus, readNativeSnapshot } from './candidate';
import { type SettledScan, settledScans } from './closed-window-scans';
import { configureNativeText, readSavedChoices } from './native-settings';
import { readDelegatedResetState, seedDelegatedResetState } from './precious-state';
import type { PublicBridges } from './public-bridges';
import {
  removeRetainedFile,
  requireHit,
  retainRootlessFile,
  searchScope,
  waitForScopes,
} from './scoped-acceptance';
import { assertActualVectorWorker, configureVectorProfile } from './vector-profile';

async function catalogSnapshot(context: ElectronAppContext): Promise<unknown> {
  return await context.window.evaluate(async () => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Precious database bridge is unavailable.');
    }
    return {
      collections: (
        await query(
          'SELECT id,model_key,model_id,dimensions,distance,name,system_role FROM embedding_sets ORDER BY id'
        )
      ).rows,
      files: (
        await query(
          'SELECT id,name,path,size,content_hash,embedding_set_id,root_id,content FROM file_records ORDER BY id'
        )
      ).rows,
    };
  });
}

async function nativeOwner(
  context: ElectronAppContext
): Promise<{ pid: number; creationTime: number }> {
  const owners = (await context.app.evaluate(({ app }) => app.getAppMetrics())).filter(
    (metric) => metric.type === 'Utility' && metric.name === 'brainstrike-indexer'
  );
  expect(owners).toHaveLength(1);
  const owner = owners[0];
  if (!owner) {
    throw new Error('Actual native utility owner is missing.');
  }
  return { creationTime: owner.creationTime, pid: owner.pid };
}

async function visibleSearch(context: ElectronAppContext, semantic: boolean): Promise<void> {
  await context.window.getByTestId('search-tab-trigger').click();
  const panel = context.window.getByTestId('explorer-search-panel-search');
  await panel.getByRole('button', { exact: true, name: semantic ? 'Semantic' : 'Text' }).click();
  await panel.getByPlaceholder('Search workspace').fill('DisposerStack');
  await panel.getByPlaceholder('Search workspace').press('Enter');
  await expect(panel.getByText('disposer-stack.ts', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByTestId('workspace-search-results-error')).toHaveCount(0);
}

for (const mode of ['TEXT', 'VECTOR'] as const) {
  test(`complete ${mode} mounted/rootless CRUD, closed-window publication, reopen, derived rebuild and root deletion`, async () => {
    test.setTimeout(mode === 'VECTOR' ? 1_200_000 : 600_000);
    if (process.platform !== 'darwin') {
      throw new Error('Closed-visible-window campaign requires the macOS keep-running lifecycle.');
    }
    const session = await createCandidateSession(`complete-${mode.toLowerCase()}`);
    const corpus = path.join(session.runDir, 'corpus');
    const retainedDirectory = path.join(session.runDir, 'retained');
    await cp(path.join(import.meta.dirname, 'corpus'), corpus, { recursive: true });
    await mkdir(retainedDirectory);
    let context: ElectronAppContext | undefined;
    try {
      context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
      if (mode === 'TEXT') {
        await configureNativeText(context);
      } else {
        await configureVectorProfile(context);
      }
      await context.window.getByTestId('select-root-button').click();
      const initial = await waitForScopes(context, { collection: 3, mode, workspace: 3 });
      if (initial.status.kind !== 'ready') {
        throw new Error('Current native store is unavailable.');
      }
      const initialStoreId = initial.status.storeId;
      const rootId = initial.status.authorizedRootIds[0];
      const collectionId = initial.status.authorizedCollectionIds?.[0];
      if (!(rootId && collectionId)) {
        throw new Error('Actual scope IDs are missing.');
      }
      const semantic = mode === 'VECTOR';
      await visibleSearch(context, semantic);
      const retainedPath = path.join(retainedDirectory, 'retained-witness.ts');
      await writeFile(
        retainedPath,
        'export const M2RetainedBefore = "retained canonical witness";\n'
      );
      const retainedId = await retainRootlessFile(context, retainedPath);
      await waitForScopes(context, { collection: 4, mode, workspace: 3 });
      const retained = { fileId: retainedId, rootless: true, sourcePath: retainedPath };
      await session.record('mounted-and-rootless-public-reads', {
        initial,
        mounted: await requireHit(
          context,
          'DisposerStack',
          { rootless: false, sourcePath: path.join(corpus, 'disposer-stack.ts') },
          semantic
        ),
        retained: await requireHit(context, 'M2RetainedBefore', retained, semantic),
      });
      const rejected = await context.window.evaluate(async () => {
        const capability = (window as unknown as PublicBridges).indexSearch;
        if (!capability) {
          throw new Error('Scoped capability missing.');
        }
        try {
          await capability.search({
            collectionId: crypto.randomUUID(),
            limit: 10,
            mode: 'bm25',
            rootIds: [],
            text: 'M2RetainedBefore',
          });
        } catch (error) {
          return String(error);
        }
        throw new Error('Unauthorized collection was accepted.');
      });
      expect(rejected).toMatch(/not authorized/i);
      await session.record('unauthorized-scope-refused', rejected);
      const addedPath = path.join(corpus, 'created-witness.ts');
      await writeFile(addedPath, 'export const M2CreatedBefore = "mounted creation";\n');
      await waitForScopes(context, { collection: 5, mode, workspace: 4 });
      await requireHit(
        context,
        'M2CreatedBefore',
        { rootless: false, sourcePath: addedPath },
        semantic
      );
      await writeFile(addedPath, 'export const M2CreatedAfter = "mounted replacement";\n');
      await writeFile(retainedPath, 'export const M2RetainedAfter = "retained replacement";\n');
      await retainRootlessFile(context, retainedPath, retainedId);
      const liveContext = context;
      await expect
        .poll(
          async () =>
            (await searchScope(liveContext, 'M2CreatedAfter', 'workspace')).bm25.hits.length,
          { timeout: 90_000 }
        )
        .toBeGreaterThan(0);
      await waitForScopes(context, { collection: 5, mode, workspace: 4 });
      await session.record('current-source-updates', {
        mounted: await requireHit(
          context,
          'M2CreatedAfter',
          { rootless: false, sourcePath: addedPath },
          semantic
        ),
        retained: await requireHit(context, 'M2RetainedAfter', retained, semantic),
      });
      for (const term of ['M2CreatedBefore', 'M2RetainedBefore']) {
        const result = await searchScope(context, term, 'collection');
        expect(result.bm25.hits).toEqual([]);
        expect(result.grep.hits).toEqual([]);
      }
      const removedRetainedPath = path.join(retainedDirectory, 'removed-retained.ts');
      await writeFile(removedRetainedPath, 'export const M2RemovedRetained = "delete retained";\n');
      const removedRetainedId = await retainRootlessFile(context, removedRetainedPath);
      await waitForScopes(context, { collection: 6, mode, workspace: 4 });
      await rm(addedPath);
      await removeRetainedFile(context, removedRetainedId);
      await rm(removedRetainedPath);
      await waitForScopes(context, { collection: 4, mode, workspace: 3 });
      for (const term of ['M2CreatedAfter', 'M2RemovedRetained']) {
        const result = await searchScope(context, term, 'collection');
        expect(result.bm25.hits).toEqual([]);
        expect(result.grep.hits).toEqual([]);
      }
      await session.record('complete-removal', await readNativeSnapshot(context));

      const owner = await nativeOwner(context);
      const beforeOutput = await getBufferedElectronOutput(context.app);
      const oldRequests = new Set(
        settledScans(beforeOutput.stdout).map((scan) => scan.receipt.ticket.requestId)
      );
      const original = await readFile(path.join(corpus, 'disposer-stack.ts'), 'utf8');
      const visible = await context.app.browserWindow(context.window);
      await visible.evaluate((window) => window.close());
      await expect
        .poll(() =>
          liveContext.app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
          )
        )
        .toBe(0);
      expect(await nativeOwner(context)).toEqual(owner);
      // Rootless original content is retained in PG, not watched from its provenance path.
      // Actual mounted mutation must publish workspace and overlapping collection receipts without a visible producer.
      await writeFile(
        path.join(corpus, 'disposer-stack.ts'),
        `${original}\nexport const M2ClosedMounted = "mounted while window closed";\n`
      );
      const mutationFinishedAt = Date.now();
      let closedReceipts: SettledScan[] = [];
      await expect
        .poll(
          async () => {
            const output = await getBufferedElectronOutput(liveContext.app);
            closedReceipts = settledScans(output.stdout).filter(
              (scan) =>
                scan.receipt.scanComplete &&
                scan.receipt.reason === 'complete' &&
                scan.receipt.ticket.storeId === initialStoreId &&
                !oldRequests.has(scan.receipt.ticket.requestId) &&
                Date.parse(scan.settledAt) >= mutationFinishedAt
            );
            return ['workspace', 'collection'].every((kind) =>
              closedReceipts.some(
                (scan) =>
                  scan.receipt.ticket.scope.kind === kind &&
                  (scan.receipt.ticket.scope.kind === 'workspace'
                    ? scan.receipt.ticket.scope.rootId === rootId
                    : scan.receipt.ticket.scope.embeddingSetId === collectionId)
              )
            );
          },
          {
            message: 'Actual committed scan tickets must settle before visible recreation',
            timeout: 90_000,
          }
        )
        .toBe(true);
      const recreatedAt = Date.now();
      await session.record('closed-window-committed-publication', {
        mutationFinishedAt,
        owner,
        receipts: closedReceipts,
        recreatedAt,
      });
      expect(await nativeOwner(context)).toEqual(owner);
      const newWindow = context.app.waitForEvent('window');
      await context.app.evaluate(({ app }) => app.emit('activate'));
      context.window = await newWindow;
      await context.window.waitForLoadState('domcontentloaded');
      await context.window.addInitScript(observeInferenceStatus);
      await context.window.evaluate(observeInferenceStatus);
      await waitForScopes(context, { collection: 4, mode, workspace: 3 });
      await session.record('recreated-visible-reads', {
        mounted: await requireHit(
          context,
          'M2ClosedMounted',
          { rootless: false, sourcePath: path.join(corpus, 'disposer-stack.ts') },
          semantic
        ),
        owner: await nativeOwner(context),
        retained: await requireHit(context, 'M2RetainedAfter', retained, semantic),
      });
      const choices = await readSavedChoices(context);
      await session.close();
      context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus });
      // Complete persisted vectors need no document inference after a cold reopen.
      // The public semantic query below must start and prove this process's worker.
      const reopened = await waitForScopes(
        context,
        { collection: 4, mode, workspace: 3 },
        { requireVectorWorker: false }
      );
      expect(reopened.status.kind === 'ready' && reopened.status.storeId).toBe(initialStoreId);
      expect(await readSavedChoices(context)).toEqual(choices);
      await requireHit(context, 'M2RetainedAfter', retained, semantic);
      const reopenedAfterQuery = await readNativeSnapshot(context);
      if (semantic) {
        assertActualVectorWorker(reopenedAfterQuery);
      }
      await session.record('same-profile-reopen', {
        choices: await readSavedChoices(context),
        snapshot: reopenedAfterQuery,
      });

      const sentinels = await seedDelegatedResetState(context.window);
      const precious = await readDelegatedResetState(context.window, sentinels);
      const catalog = await catalogSnapshot(context);
      const oldOwner = await nativeOwner(context);
      const indices = (await readdir(session.userDataDir, { recursive: true })).filter((name) =>
        name.endsWith('index.sqlite')
      );
      expect(indices).toHaveLength(1);
      const index = indices[0];
      if (!index) {
        throw new Error('Derived SQLite path unavailable.');
      }
      const oldFile = await stat(path.join(session.userDataDir, index));
      await new HomePage(context.window).openSettings();
      const section = await new SettingsPage(context.window).openCategory(
        /Search & Indexing/i,
        'search-indexing'
      );
      await section.getByRole('button', { exact: true, name: 'Rebuild search index' }).click();
      await expect(
        section.getByRole('button', { exact: true, name: 'Rebuild search index' })
      ).toBeEnabled({ timeout: 90_000 });
      await expect(section.getByRole('alert')).toHaveCount(0);
      await new HomePage(context.window).leaveSettings();
      const rebuilt = await waitForScopes(context, { collection: 4, mode, workspace: 3 });
      expect(rebuilt.status.kind === 'ready' && rebuilt.status.storeId).not.toBe(initialStoreId);
      expect(() => process.kill(oldOwner.pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' })
      );
      expect(await readSavedChoices(context)).toEqual(choices);
      expect(await readDelegatedResetState(context.window, sentinels)).toEqual(precious);
      expect(await catalogSnapshot(context)).toEqual(catalog);
      await session.record('derived-only-rebuild-preserves-precious-data', {
        catalog,
        choices,
        newOwner: await nativeOwner(context),
        oldFile: { ino: oldFile.ino, size: oldFile.size },
        oldOwner,
        precious,
        retained: await requireHit(context, 'M2RetainedAfter', retained, semantic),
        snapshot: rebuilt,
      });

      await context.window.getByTestId('explorer-tab-trigger').click();
      await context.window.getByTestId('single-root-header-row').click({ button: 'right' });
      await context.window.getByRole('menuitem', { name: /Disconnect/ }).click();
      const dialog = context.window.getByRole('dialog', {
        name: `Disconnect ${path.basename(corpus)}?`,
      });
      await dialog.getByRole('checkbox', { name: 'Also delete indexed data' }).check();
      await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
      await expect(dialog).toBeHidden({ timeout: 90_000 });
      await waitForScopes(context, { collection: 1, mode, workspace: 0 });
      const remaining = await context.window.evaluate(async (rootId) => {
        const query = (window as unknown as PublicBridges).electronAPI?.db.query;
        if (!query) {
          throw new Error('Canonical catalog bridge unavailable.');
        }
        return (await query('SELECT id FROM file_records WHERE root_id=$1', [rootId])).rows;
      }, rootId);
      expect(remaining).toEqual([]);
      const revoked = await context.window.evaluate(async (rootId) => {
        const capability = (window as unknown as PublicBridges).indexSearch;
        if (!capability) {
          throw new Error('Scoped capability missing.');
        }
        try {
          await capability.search({
            limit: 10,
            mode: 'bm25',
            rootIds: [rootId],
            text: 'DisposerStack',
          });
        } catch (error) {
          return String(error);
        }
        throw new Error('Disconnected root retained native read authorization.');
      }, rootId);
      expect(revoked).toMatch(/not.*authorized|no longer authorized/i);
      await session.record('deleted-root-authorization-refused', revoked);
      expect(await readDelegatedResetState(context.window, sentinels)).toEqual(precious);
      await session.record('whole-root-delete-preserves-rootless-and-chat', {
        remaining,
        retained: await requireHit(context, 'M2RetainedAfter', retained, semantic),
        snapshot: await readNativeSnapshot(context),
      });
    } catch (error) {
      await session.record('failure', { message: String(error) });
      throw error;
    } finally {
      await session.close();
    }
  });
}
