import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureFileExplorerPanelVisible,
  expect,
  seedRestoredExplicitSelectionState,
  test,
} from './file-explorer-selection.shared';
import {
  holdDeveloperResetDialog,
  holdExplorerAdapter,
  readCanonicalExplorer,
} from './utils/explorer-persistence-close-gate';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface Observation {
  acknowledgements: number;
  at: number;
  pending: number;
  phase: string;
  rejections: number;
  sameFailure?: boolean;
}
type OwnerWindow = Window & {
  __brainstrike_file_explorer_provider_store__?: {
    preparePersistenceClose(): Promise<void>;
    drainPersistence(): Promise<void>;
    persist: {
      getOptions(): { storage?: { setItem(name: string, value: unknown): Promise<unknown> } };
      setOptions(options: {
        storage: { setItem(name: string, value: unknown): Promise<unknown> };
      }): void;
    };
  };
  __bst2258ExplorerClose?: {
    prepares: number;
    pending: Promise<unknown>[];
    callerFailure?: unknown;
    preparationFailure?: unknown;
  };
};

for (const mode of [
  'quit-ack-first',
  'quit-held',
  'reload-held',
  'developer-reset-held',
  'quit-rejection',
] as const) {
  test(`Explorer canonical adapter completion owns ${mode} @smoke`, async ({
    electronHarness,
  }, testInfo) => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-explorer-close-'));
    const observations: Observation[] = [];
    let canRestore = () => false;
    let gate: Awaited<ReturnType<typeof holdExplorerAdapter>> | undefined;
    let resetDialog: Awaited<ReturnType<typeof holdDeveloperResetDialog>> | undefined;
    const reload = mode === 'reload-held' || mode === 'developer-reset-held';
    let resetReceipt: { writesAtDeletion: number; writesAfterLateWatch: number } | undefined;
    try {
      await mkdir(path.join(rootPath, 'src'));
      await writeFile(path.join(rootPath, 'src', 'saved-edit.ts'), 'export const saved = true;');
      await seedRestoredExplicitSelectionState({
        electronHarness,
        expandedDirectoryPaths: [],
        rootPath,
        selectedFilePaths: [],
      });
      const context = await electronHarness.restart();
      const mainProcess = context.app.process();
      canRestore = () => mainProcess.exitCode === null && mainProcess.signalCode === null;
      const userData = await context.app.evaluate(({ app }) => app.getPath('userData'));
      const page = context.window;
      const { reloadRenderer } = await loadElectronHelpers();
      await reloadRenderer(page, 'Explorer close owner fixture');
      await ensureFileExplorerPanelVisible(page);
      const tree = page.getByRole('treegrid', { name: 'File tree' });
      await expect(tree.getByText('src', { exact: true })).toBeVisible();
      page.on('console', (message) => {
        const prefix = '[ExplorerCloseControl] ';
        if (message.text().startsWith(prefix)) {
          observations.push(JSON.parse(message.text().slice(prefix.length)) as Observation);
        }
      });
      const originalOrigin = await page.evaluate(() => performance.timeOrigin);
      await page.evaluate(() => {
        const scope = window as OwnerWindow;
        const store = scope.__brainstrike_file_explorer_provider_store__;
        const storage = store?.persist.getOptions().storage;
        if (!(store && storage)) {
          throw new Error('Canonical Explorer owner is absent');
        }
        const state = {
          callerFailure: undefined as unknown,
          pending: [] as Promise<unknown>[],
          preparationFailure: undefined as unknown,
          prepares: 0,
        };
        scope.__bst2258ExplorerClose = state;
        let callers = 0;
        let acknowledgements = 0;
        let rejections = 0;
        const record = (phase: string, sameFailure?: boolean) =>
          console.warn(
            '[ExplorerCloseControl] ' +
              JSON.stringify({
                acknowledgements,
                at: Date.now(),
                pending: callers - acknowledgements - rejections,
                phase,
                rejections,
                sameFailure,
              })
          );
        store.persist.setOptions({
          storage: {
            ...storage,
            setItem: (name, value) => {
              callers += 1;
              const completion = storage.setItem(name, value);
              state.pending.push(completion);
              record('caller-admitted');
              void completion.then(
                () => {
                  acknowledgements += 1;
                  record('caller-ack');
                },
                (error: unknown) => {
                  state.callerFailure = error;
                  rejections += 1;
                  record('caller-rejected');
                }
              );
              return completion;
            },
          },
        });
        const prepare = store.preparePersistenceClose.bind(store);
        store.preparePersistenceClose = () => {
          const completion = prepare();
          state.prepares += 1;
          record('prepare-admitted');
          void completion.then(
            () => record('prepare-ack'),
            (error: unknown) => {
              state.preparationFailure = error;
              record('prepare-rejected', state.callerFailure === error);
            }
          );
          return completion;
        };
        window.addEventListener('beforeunload', () => record('before-unload'));
      });
      gate = await holdExplorerAdapter(context.app, rootPath);
      await tree
        .getByRole('row')
        .filter({ has: page.getByRole('checkbox', { exact: true, name: 'Select src' }) })
        .getByRole('button', { exact: true, name: 'Expand' })
        .click();
      await expect(tree.getByText('saved-edit.ts', { exact: true })).toBeVisible();
      await expect
        .poll(async () => await gate!.evaluate((control) => control.status().held))
        .toBe(true);
      expect((await readCanonicalExplorer(userData, rootPath)).expanded).toBe(false);
      const held = await gate.evaluate((control) => control.status());
      if (mode === 'quit-ack-first') {
        await gate.evaluate((control) => control.release(false));
        await page.evaluate(async () => {
          await Promise.all((window as OwnerWindow).__bst2258ExplorerClose!.pending);
        });
      }
      const collapseBox = await tree
        .getByRole('row')
        .filter({ has: page.getByRole('checkbox', { exact: true, name: 'Select src' }) })
        .getByRole('button', { exact: true, name: 'Collapse' })
        .boundingBox();
      if (!collapseBox) {
        throw new Error('Expanded fixture row has no native input target');
      }
      let inputRefused = false;
      let closing: Promise<void> | undefined;
      let navigation: Promise<unknown> | undefined;
      if (reload) {
        navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
        if (mode === 'developer-reset-held') {
          resetDialog = await holdDeveloperResetDialog(context.app);
          await resetDialog.evaluate((control) => control.begin());
        } else {
          const windowId = await (await context.app.browserWindow(page)).evaluate(
            (window) => window.id
          );
          await context.app.evaluate(({ BrowserWindow, Menu }, id) => {
            const target = BrowserWindow.fromId(id);
            const item = Menu.getApplicationMenu()
              ?.items.find(({ label }) => label === 'View')
              ?.submenu?.items.find(({ label }) => label === 'Reload');
            if (!(target && item)) {
              throw new Error('Native Reload menu target is absent');
            }
            item.click(undefined, target, target.webContents);
          }, windowId);
        }
      } else {
        closing = electronHarness.endOutOfBand(async (process) => {
          const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
          await context.app.evaluate(({ app }) => app.quit());
          await exited;
        });
      }
      if (mode !== 'quit-ack-first') {
        await page.waitForFunction(
          () => (window as OwnerWindow).__bst2258ExplorerClose!.prepares > 0
        );
        expect(page.isClosed()).toBe(false);
        expect(mainProcess.exitCode).toBeNull();
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalOrigin);
        const callers = observations.filter((event) => event.phase === 'caller-admitted').length;
        await page.mouse.click(
          collapseBox.x + collapseBox.width / 2,
          collapseBox.y + collapseBox.height / 2
        );
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
        });
        inputRefused =
          observations.filter((event) => event.phase === 'caller-admitted').length === callers;
        expect(inputRefused).toBe(true);
        await gate.evaluate(
          (control, reject) => control.release(reject),
          mode === 'quit-rejection'
        );
      }
      if (resetDialog) {
        await expect
          .poll(async () => await resetDialog!.evaluate((control) => control.status().deleted))
          .toBe(true);
        const writesAtDeletion = observations.filter(
          (event) => event.phase === 'caller-admitted'
        ).length;
        await writeFile(path.join(rootPath, 'src', 'late-watch.ts'), 'export const late = true;');
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        const writesAfterLateWatch = observations.filter(
          (event) => event.phase === 'caller-admitted'
        ).length;
        expect(writesAfterLateWatch).toBe(writesAtDeletion);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalOrigin);
        resetReceipt = { writesAfterLateWatch, writesAtDeletion };
        await resetDialog.evaluate((control) => control.release());
      }
      if (navigation) {
        await navigation;
      }
      if (closing) {
        await closing;
      }
      const canonical = await readCanonicalExplorer(userData, rootPath);
      if (reload) {
        await ensureFileExplorerPanelVisible(page);
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(originalOrigin);
        await expect(
          page
            .getByRole('treegrid', { name: 'File tree' })
            .getByText('saved-edit.ts', { exact: true })
        ).toBeVisible();
      } else {
        const reopened = await electronHarness.ensureContext();
        await ensureFileExplorerPanelVisible(reopened.window);
        await expect(
          reopened.window
            .getByRole('treegrid', { name: 'File tree' })
            .getByText('src', { exact: true })
        ).toBeVisible();
        if (mode !== 'quit-rejection') {
          await expect(
            reopened.window
              .getByRole('treegrid', { name: 'File tree' })
              .getByText('saved-edit.ts', { exact: true })
          ).toBeVisible();
        }
      }
      const receipt = { canonical, held, inputRefused, mode, observations, resetReceipt };
      await testInfo.attach(`explorer-${mode}`, {
        body: JSON.stringify(receipt),
        contentType: 'application/json',
      });
      expect(observations.some((event) => event.phase === 'prepare-admitted')).toBe(true);
      expect(observations.find((event) => event.phase === 'before-unload')?.pending).toBe(0);
      if (mode === 'quit-rejection') {
        expect(observations.some((event) => event.phase === 'caller-rejected')).toBe(true);
        expect(observations.some((event) => event.phase === 'prepare-rejected')).toBe(true);
        expect(observations.find((event) => event.phase === 'prepare-rejected')?.sameFailure).toBe(
          true
        );
        expect(canonical.expanded).toBe(false);
      } else {
        expect(observations.some((event) => event.phase === 'caller-ack')).toBe(true);
        expect(canonical.expanded).toBe(true);
      }
    } finally {
      try {
        if (canRestore()) {
          if (resetDialog) {
            await resetDialog.evaluate((control) => control.restore());
          }
          if (gate) {
            await gate.evaluate((control) => control.restore());
          }
        }
      } finally {
        await electronHarness.dispose();
        await rm(rootPath, { force: true, recursive: true });
      }
    }
  });
}
