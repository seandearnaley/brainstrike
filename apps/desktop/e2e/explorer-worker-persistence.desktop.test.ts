import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureFileExplorerPanelVisible,
  expect,
  seedRestoredExplicitSelectionState,
  test,
} from './file-explorer-selection.shared';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface SaveReplyGate {
  armed: boolean;
  armedAt: number;
  pending: Promise<unknown>[];
  release: (() => void)[];
  saves: number;
}

interface ExplorerPersistenceWindow extends Window {
  __brainstrike_file_explorer_provider_store__?: {
    persist: {
      getOptions(): {
        storage?: { setItem(name: string, value: unknown): Promise<unknown> };
      };
      setOptions(options: {
        storage: { setItem(name: string, value: unknown): Promise<unknown> };
      }): void;
    };
  };
  __bst2258SaveReplyGate?: SaveReplyGate;
}

/** Hold only the redundant worker reply, after the real adapter has committed. */
function installSaveReplyGate(): void {
  const scope = window as ExplorerPersistenceWindow;
  const gate: SaveReplyGate = { armed: false, armedAt: 0, pending: [], release: [], saves: 0 };
  scope.__bst2258SaveReplyGate = gate;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    private readonly explorerStorage: boolean;
    private readonly saveIds = new Set<string>();

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.explorerStorage = url.toString().includes('worker-storage.worker');
    }

    override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const request = message as { id?: string; type?: string };
      if (this.explorerStorage && gate.armed && request.type === 'save' && request.id) {
        this.saveIds.add(request.id);
        gate.saves += 1;
      }
      if (Array.isArray(options)) {
        super.postMessage(message, options);
        return;
      }
      super.postMessage(message, options);
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) {
      if (!(this.explorerStorage && type === 'message' && listener)) {
        super.addEventListener(type, listener, options);
        return;
      }
      super.addEventListener(
        'message',
        (event: MessageEvent<{ id?: string; type?: string }>) => {
          const deliver = () => {
            if (typeof listener === 'function') {
              listener.call(this, event);
            } else {
              listener.handleEvent(event);
            }
          };
          if (
            gate.armed &&
            event.data.type === 'success' &&
            event.data.id &&
            this.saveIds.has(event.data.id)
          ) {
            gate.release.push(deliver);
            return;
          }
          deliver();
        },
        options
      );
    }
  };
}

test('@smoke Explorer edits reopen after an adapter ACK with worker replies held', async ({
  electronHarness,
}, testInfo) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-explorer-worker-'));
  const persistenceErrors: string[] = [];
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
    await context.app.context().addInitScript(installSaveReplyGate);
    const page = context.window;
    page.on('console', (message) => {
      const text = message.text();
      if (
        text.includes('Worker setItem failed') ||
        text.includes('Worker request timeout') ||
        text.includes('Failed to flush pending worker storage write')
      ) {
        persistenceErrors.push(text);
      }
    });
    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'BST-2258 Explorer worker ACK');
    await ensureFileExplorerPanelVisible(page);
    const tree = page.getByRole('treegrid', { name: 'File tree' });
    await expect(tree.getByText('src', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const scope = window as ExplorerPersistenceWindow;
      const gate = scope.__bst2258SaveReplyGate;
      const persist = scope.__brainstrike_file_explorer_provider_store__?.persist;
      const storage = persist?.getOptions().storage;
      if (!(gate && persist && storage)) {
        throw new Error('Explorer persistence boundary is unavailable');
      }
      persist.setOptions({
        storage: {
          ...storage,
          setItem: (name, value) => {
            const completion = storage.setItem(name, value);
            gate.pending.push(completion);
            return completion;
          },
        },
      });
      gate.armed = true;
      gate.armedAt = Date.now();
    });
    const directory = tree.getByRole('row').filter({
      has: page.getByRole('checkbox', { exact: true, name: 'Select src' }),
    });
    await directory.getByRole('button', { exact: true, name: 'Expand' }).click();
    await expect(tree.getByText('saved-edit.ts', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as ExplorerPersistenceWindow).__bst2258SaveReplyGate?.saves ?? 0
        )
      )
      .toBeGreaterThan(0);
    const observation = await page.evaluate(async () => {
      const gate = (window as ExplorerPersistenceWindow).__bst2258SaveReplyGate;
      if (!gate?.pending.length || gate.saves === 0) {
        throw new Error('Explorer edit did not reach the worker persistence boundary');
      }
      await Promise.all(gate.pending);
      gate.armed = false;
      for (const deliver of gate.release) {
        deliver();
      }
      return {
        acknowledgedAt: Date.now(),
        armedAt: gate.armedAt,
        finalSaveRepliesHeld: gate.release.length,
        savesObserved: gate.saves,
      };
    });
    await testInfo.attach('explorer-worker-ack', {
      body: JSON.stringify({ mainPid: context.app.process().pid, ...observation }),
      contentType: 'application/json',
    });
    expect(observation.savesObserved).toBeGreaterThan(0);
    expect(persistenceErrors).toEqual([]);
    const reopened = await electronHarness.restart();
    await ensureFileExplorerPanelVisible(reopened.window);
    await expect(
      reopened.window
        .getByRole('treegrid', { name: 'File tree' })
        .getByText('saved-edit.ts', { exact: true })
    ).toBeVisible();
  } finally {
    await electronHarness.dispose();
    await rm(rootPath, { force: true, recursive: true });
  }
});
