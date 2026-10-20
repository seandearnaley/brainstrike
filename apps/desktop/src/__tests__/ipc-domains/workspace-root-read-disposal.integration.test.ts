import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import {
  createNativeSecureRoot,
  resolveValidatedReadPath,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createFileSystemIpcDomain } from '../../ipc-domains/file-system-ipc';
import {
  capabilityHandler,
  createFileSystem,
  createStorage,
  getRootsCatalog,
  handlers,
  resetRootsCatalog,
} from './file-system-ipc-test-harness';
import { rootHandle } from './workspace-root-registry-test-helpers';

describe('Filesystem shutdown joins actual secure-fs direct reads (BST-2251)', () => {
  beforeEach(() => {
    handlers.clear();
    resetRootsCatalog();
  });

  it.each(['directory', 'file', 'absolute'] as const)(
    'joins an admitted %s IPC through late resolution and native completion',
    async (kind) => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'brainstrike-direct-read-disposal-'));
      const workspace = path.join(fixture, 'workspace');
      await mkdir(workspace);
      const filePath = path.join(workspace, 'inside.txt');
      await writeFile(filePath, 'actual native bytes');
      const resolving = Promise.withResolvers<void>();
      const pathReady = Promise.withResolvers<void>();
      const close = vi.fn();
      const domain = createFileSystemIpcDomain({
        disposeCommandSessionsForRoot: async () => 0,
        evictLspServersForRoot: async () => undefined,
        fileSystem: createFileSystem(workspace),
        getRootsCatalog,
        isSyntheticFileSystemPath: () => false,
        storage: createStorage(),
        workspaceRootRegistryFileSystemSeams: {
          createSecureRoot: async (requested) => {
            const native = await createNativeSecureRoot(requested);
            return {
              ...native,
              close: () => {
                close();
                native.close();
              },
            };
          },
          resolveReadPath: async (requested, canonical) => {
            resolving.resolve();
            await pathReady.promise;
            return resolveValidatedReadPath(requested, canonical);
          },
        },
      });
      const descriptor = await domain.roots.addRoot(rootHandle(workspace));
      const event = createTrustedInvokeEvent();
      const channel =
        kind === 'directory'
          ? 'fs:readDirectory'
          : kind === 'file'
            ? 'fs:readFile'
            : 'fs:readFileByAbsolutePath';
      const args =
        kind === 'directory'
          ? [descriptor.handle]
          : kind === 'file'
            ? [
                {
                  kind: 'file',
                  name: 'inside.txt',
                  path: filePath,
                  platform: 'electron',
                  rootId: descriptor.rootId,
                },
              ]
            : [filePath, workspace, descriptor.rootId];
      const reading = Promise.resolve(capabilityHandler(channel)(event, ...args));
      await resolving.promise;
      const disposing = domain.close();
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(close).not.toHaveBeenCalled();
        expect(handlers.size).toBe(0);
        pathReady.resolve();
        if (kind === 'directory') {
          await expect(reading).resolves.toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'inside.txt' })])
          );
        } else {
          await expect(reading).resolves.toBe('actual native bytes');
        }
        await disposing;
        expect(close).toHaveBeenCalledOnce();
      } finally {
        pathReady.resolve();
        await Promise.allSettled([reading, disposing]);
        await domain.close();
        await rm(fixture, { force: true, recursive: true });
      }
    }
  );
});
