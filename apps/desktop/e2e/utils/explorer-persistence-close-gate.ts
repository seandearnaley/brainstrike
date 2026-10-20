import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FILE_EXPLORER_STORAGE_KEY } from '@brainstrike/file-explorer/testing';
import type { ElectronApplication } from '@playwright/test';

/** Hold the existing writer's atomic commit, only for this disposable UI edit. */
export async function holdExplorerAdapter(app: ElectronApplication, rootPath: string) {
  return app.evaluateHandle(
    async ({ app }, { rootPath, key }) => {
      const fs = process.getBuiltinModule('fs/promises');
      const { join } = process.getBuiltinModule('path');
      const { syncBuiltinESMExports } = process.getBuiltinModule('module');
      const destination = join(app.getPath('userData'), 'electron-storage.json');
      const directory = join(rootPath, 'src');
      const original = fs.rename;
      const acknowledgement = Promise.withResolvers<void>();
      let armed = true;
      let held = false;
      let heldAt: number | undefined;
      let releasedAt: number | undefined;
      fs.rename = async (from, to) => {
        if (armed && String(to) === destination) {
          const document = JSON.parse(await fs.readFile(from, 'utf8')) as Record<string, string>;
          const encoded = document[key];
          if (encoded) {
            const snapshot = JSON.parse(encoded) as {
              state: {
                rootDescriptors: Record<string, { path: string }>;
                folderStates: Record<string, { expandedDirectoryPaths: string[] }>;
              };
            };
            const roots = Object.entries(snapshot.state.rootDescriptors).filter(
              ([, descriptor]) => descriptor.path === rootPath
            );
            const root = roots[0];
            if (
              roots.length === 1 &&
              root &&
              snapshot.state.folderStates[root[0]]?.expandedDirectoryPaths.includes(directory)
            ) {
              armed = false;
              held = true;
              heldAt = Date.now();
              await acknowledgement.promise;
            }
          }
        }
        await original(from, to);
      };
      // Node's documented builtin synchronization keeps ESM/CJS consumers on
      // the same test interception: https://nodejs.org/api/esm.html#built-in-modules
      syncBuiltinESMExports();
      return {
        release: (reject: boolean) => {
          releasedAt = Date.now();
          if (reject) {
            acknowledgement.reject(new Error('Controlled Explorer adapter rejection'));
          } else {
            acknowledgement.resolve();
          }
        },
        restore: () => {
          fs.rename = original;
          syncBuiltinESMExports();
          acknowledgement.resolve();
        },
        status: () => ({ held, heldAt, releasedAt }),
      };
    },
    { key: FILE_EXPLORER_STORAGE_KEY, rootPath }
  );
}

/** Inspect the current-format root folder fact without emitting its path/value. */
export async function readCanonicalExplorer(userData: string, rootPath: string) {
  const document = JSON.parse(
    await readFile(path.join(userData, 'electron-storage.json'), 'utf8')
  ) as Record<string, string>;
  const encoded = document[FILE_EXPLORER_STORAGE_KEY];
  if (!encoded) {
    throw new Error('Canonical Explorer entry is absent');
  }
  const snapshot = JSON.parse(encoded) as {
    state: {
      rootDescriptors: Record<string, { path: string }>;
      folderStates: Record<string, { expandedDirectoryPaths: string[] }>;
    };
  };
  const roots = Object.entries(snapshot.state.rootDescriptors).filter(
    ([, descriptor]) => descriptor.path === rootPath
  );
  const root = roots[0];
  if (roots.length !== 1 || !root) {
    throw new Error('Canonical fixture root is ambiguous or absent');
  }
  const expanded = snapshot.state.folderStates[root[0]]?.expandedDirectoryPaths;
  if (!Array.isArray(expanded)) {
    throw new Error('Canonical root folder state is malformed');
  }
  return { expanded: expanded.includes(path.join(rootPath, 'src')) };
}

/** Actual Developer menu reset; hold its post-deletion dialog before navigation. */
export async function holdDeveloperResetDialog(app: ElectronApplication) {
  return app.evaluateHandle(({ dialog, Menu }) => {
    const original = dialog.showMessageBox;
    const dismissed = Promise.withResolvers<void>();
    let deleted = false;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; message?: string };
      if (options.title === 'Reset Local Database') {
        return { checkboxChecked: false, response: 0 };
      }
      if (
        options.title === 'Database Reset' &&
        options.message === 'Local database has been reset. The app will reload.'
      ) {
        deleted = true;
        await dismissed.promise;
        return { checkboxChecked: false, response: 0 };
      }
      return Reflect.apply(original, dialog, args);
    }) as typeof dialog.showMessageBox;
    const item = Menu.getApplicationMenu()?.getMenuItemById('dev-reset-db');
    if (!item) {
      throw new Error('Native developer database reset menu is absent');
    }
    return {
      begin: () => {
        item.click(undefined, undefined, undefined);
      },
      release: () => dismissed.resolve(),
      restore: () => {
        dialog.showMessageBox = original;
        dismissed.resolve();
      },
      status: () => ({ deleted }),
    };
  });
}
