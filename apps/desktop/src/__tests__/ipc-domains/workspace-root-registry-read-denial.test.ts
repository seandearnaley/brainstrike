import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessError, type DirectoryHandle } from '@brainstrike/file-system';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { describe, expect, it, vi } from 'vitest';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';
import { createRegistryCatalogRequest } from './workspace-root-registry-test-helpers';

function createStorage(): ElectronStorageAdapter {
  const values = new Map<string, string>();
  return {
    clear: vi.fn(async () => values.clear()),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

function rootHandle(rootPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(rootPath),
    path: rootPath,
    platform: 'electron',
  };
}

function secureRoot(canonicalPath: string): SecureWorkspaceRoot {
  return {
    canonicalPath,
    close: vi.fn(),
    listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
    readFile: vi.fn(async () => ({ content: Buffer.from('inside'), status: 'ok' as const })),
  };
}

function createRegistry(
  overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {}
): WorkspaceRootRegistry {
  const catalog = { workspaceRoots: createRegistryCatalogRequest() };
  return new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath) => secureRoot(rootPath),
    disposeCommandSessionsForRoot: vi.fn(async () => 0),
    evictLspServersForRoot: vi.fn(async () => undefined),
    getRootsCatalog: async () => catalog,
    pathExists: async () => true,
    resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
    storage: createStorage(),
    ...overrides,
  });
}

function captureReadDenials(): { readonly records: LogRecord[]; readonly remove: () => void } {
  const records: LogRecord[] = [];
  const remove = addLogListener((record) => {
    if (
      record.scope === 'WorkspaceRootRegistry' &&
      record.level === LogLevel.WARN &&
      record.message === 'Workspace read denied'
    ) {
      records.push(record);
    }
  });
  return { records, remove };
}

function requireDiagnosticMetadata(record: LogRecord | undefined): Record<string, unknown> {
  const fields = record?.args[1];
  if (!(fields && typeof fields === 'object')) {
    throw new Error('Missing workspace read denial diagnostic fields');
  }
  return fields as Record<string, unknown>;
}

describe('WorkspaceRootRegistry read-denial projection', () => {
  it('projects realpath denial metadata without reinjecting an overlong controlled path', async () => {
    const captured = captureReadDenials();
    const rootPath = await mkdtemp(path.join(tmpdir(), 'bst-1159-denial-message-'));
    const rawTail = 'RAW_REALPATH_TAIL_MUST_NOT_APPEAR';
    const requestedPath = path.join(rootPath, `renderer-controlled-${'x'.repeat(1024)}${rawTail}`);
    try {
      const registry = createRegistry();
      const descriptor = await registry.addRoot(rootHandle(rootPath));

      await expect(
        registry.readFileByAbsolutePath(requestedPath, rootPath, descriptor.rootId)
      ).rejects.toThrow();

      expect(captured.records).toHaveLength(1);
      const metadata = requireDiagnosticMetadata(captured.records[0]);
      expect(metadata).toMatchObject({
        category: 'path-validation',
        code: 'realpath-failure',
        operation: 'readFileByAbsolutePath',
        rootId: null,
      });
      expect(metadata['requestedPath']).toEqual(expect.any(String));
      expect((metadata['requestedPath'] as string).length).toBeLessThanOrEqual(256);
      expect(metadata['message']).toBe('Workspace read path validation failed.');
      expect((metadata['message'] as string).length).toBeLessThanOrEqual(256);
      expect(metadata['message']).not.toContain('renderer-controlled');
      expect(metadata['message']).not.toContain(rawTail);
      expect(metadata['message']).not.toMatch(/[\n\r\t]/u);
    } finally {
      captured.remove();
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it('projects a control-bearing ENAMETOOLONG denial message to safe static metadata', async () => {
    const captured = captureReadDenials();
    const rootPath = await mkdtemp(path.join(tmpdir(), 'bst-1159-denial-code-'));
    const rawTail = 'RAW_ERROR_TAIL_MUST_NOT_APPEAR';
    try {
      const registry = createRegistry({
        resolveReadPath: async (requestedPath) => {
          const error = new AccessError(
            `ENAMETOOLONG: realpath '${requestedPath}'\nrenderer\t${rawTail}`,
            requestedPath,
            'read'
          ) as AccessError & { code: string };
          error.code = 'ENAMETOOLONG';
          throw error;
        },
      });
      const descriptor = await registry.addRoot(rootHandle(rootPath));
      const requestedPath = path.join(rootPath, 'renderer-controlled-file.txt');

      await expect(
        registry.readFileByAbsolutePath(requestedPath, rootPath, descriptor.rootId)
      ).rejects.toThrow();

      expect(captured.records).toHaveLength(1);
      const metadata = requireDiagnosticMetadata(captured.records[0]);
      expect(metadata).toMatchObject({
        category: 'filesystem',
        code: 'ENAMETOOLONG',
        message: 'Workspace read filesystem operation failed.',
        operation: 'readFileByAbsolutePath',
        rootId: null,
      });
      expect((metadata['message'] as string).length).toBeLessThanOrEqual(256);
      expect(metadata['message']).not.toContain(requestedPath);
      expect(metadata['message']).not.toContain(rawTail);
      expect(metadata['message']).not.toMatch(/[\n\r\t]/u);
    } finally {
      captured.remove();
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});
