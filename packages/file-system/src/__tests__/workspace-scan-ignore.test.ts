import type { DirectoryHandle, FileHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  discoverWorkspaceFiles,
  type WorkspaceScanDiscovery,
  type WorkspaceScanScope,
} from '../workspace-scan.js';
import { toTruncatedRelativePrefixes } from '../workspace-scan-paths.js';
import { collectScopedRemovalInvalidations } from '../workspace-scan-reconciliation.js';

const rootHandle: DirectoryHandle = {
  kind: 'directory',
  name: 'workspace',
  path: '/workspace',
  platform: 'electron',
  rootId: 'root',
};

interface WorkspaceFixture {
  readonly adapter: Pick<FileSystemAdapter, 'readDirectory' | 'readFile'>;
  readonly listed: string[];
  readonly read: string[];
  scan(scope?: WorkspaceScanScope): Promise<WorkspaceScanDiscovery>;
}

function fixture(files: Readonly<Record<string, string>>): WorkspaceFixture {
  const listed: string[] = [];
  const read: string[] = [];
  const readDirectory = async (handle: DirectoryHandle): Promise<IFileNode[]> => {
    const directory = handle.path.slice('/workspace'.length).replace(/^\//u, '');
    listed.push(directory);
    const prefix = directory ? `${directory}/` : '';
    const nodes = new Map<string, IFileNode>();
    for (const relativePath of Object.keys(files)) {
      if (!relativePath.startsWith(prefix)) {
        continue;
      }
      const suffix = relativePath.slice(prefix.length);
      const name = suffix.split('/')[0]!;
      const type = suffix.includes('/') ? 'directory' : 'file';
      const descriptor = {
        name,
        path: `/workspace/${prefix}${name}`,
        platform: 'electron' as const,
        rootId: 'root',
      };
      const handle: DirectoryHandle | FileHandle =
        type === 'file' ? { ...descriptor, kind: 'file' } : { ...descriptor, kind: 'directory' };
      nodes.set(name, {
        depth: 1,
        handle,
        name,
        path: `/workspace/${prefix}${name}`,
        rootFolderId: '/workspace',
        selectionState: 'unchecked',
        ...(type === 'file' ? { size: files[relativePath]!.length } : {}),
        type,
      });
    }
    return [...nodes.values()];
  };
  const readFile = async (handle: FileHandle): Promise<string> => {
    const relativePath = handle.path.slice('/workspace/'.length);
    read.push(relativePath);
    const content = files[relativePath];
    if (content === undefined) {
      throw new Error('File not found');
    }
    return content;
  };
  const adapter = { readDirectory, readFile };
  return {
    adapter,
    listed,
    read,
    scan: (scope: WorkspaceScanScope = { mode: 'full' }) =>
      discoverWorkspaceFiles({
        abortSignal: new AbortController().signal,
        deps: { fileSystemAdapter: adapter },
        indexingPolicyPreset: 'full-root',
        onScanningPath: () => {},
        rootHandle,
        rootPath: rootHandle.path,
        scope,
      }),
  };
}

describe('Workspace Index ignore discovery (BST-1921)', () => {
  it('honors root and nested gitignore rules before traversal without widening worktree exclusions', async () => {
    const tree = fixture({
      '.claude/worktrees/agent/copy.ts': 'copied worktree',
      '.gitignore': 'generated/\nsrc/*.ts\n',
      'generated/copy.ts': 'copied code',
      'other/keep.ts': 'sibling code',
      'src/.gitignore': '!keep.ts\n',
      'src/drop.ts': 'ignored code',
      'src/keep.ts': 'kept code',
    });
    const result = await tree.scan();
    expect(result.fileNodes.map((node) => node.path).sort()).toEqual([
      '/workspace/.gitignore',
      '/workspace/other/keep.ts',
      '/workspace/src/.gitignore',
      '/workspace/src/keep.ts',
    ]);
    expect(tree.listed).not.toContain('generated');
    expect(tree.listed).not.toContain('.claude/worktrees');
  });

  it('reconciles the full root after an ignore file changes and rereads rules in the next scan', async () => {
    const files = { '.gitignore': 'old.ts\n', 'new.ts': 'new code', 'old.ts': 'old code' };
    const tree = fixture(files);
    const first = await tree.scan({
      changes: [{ kind: 'file', path: '/workspace/.gitignore', type: 'modified' }],
      mode: 'paths',
    });
    expect(first.fileNodes.map((node) => node.path).sort()).toEqual([
      '/workspace/.gitignore',
      '/workspace/new.ts',
    ]);
    expect(first.scope).toEqual({ mode: 'full' });
    files['.gitignore'] = 'new.ts\n';
    expect((await tree.scan()).fileNodes.map((node) => node.path).sort()).toEqual([
      '/workspace/.gitignore',
      '/workspace/old.ts',
    ]);
  });

  it('keeps scoped changes under ignore rules and refuses an unreadable rule file', async () => {
    const tree = fixture({ '.gitignore': 'ignored/\n', 'ignored/a.ts': 'code' });
    expect(
      (
        await tree.scan({
          changes: [{ kind: 'file', path: '/workspace/ignored/a.ts', type: 'modified' }],
          mode: 'paths',
        })
      ).fileNodes
    ).toEqual([]);
    tree.adapter.readFile = async () => {
      throw new Error('EACCES: unreadable ignore file');
    };
    await expect(tree.scan()).rejects.toThrow('EACCES');
  });

  it('retains a truncation notice without admitting files under unknown ignore rules', async () => {
    const tree = fixture({ 'possibly-ignored.ts': 'code' });
    const readDirectory = tree.adapter.readDirectory;
    tree.adapter.readDirectory = async (handle) => [
      ...(await readDirectory(handle)),
      {
        depth: 1,
        handle: {
          kind: 'file',
          name: 'truncated',
          path: '/workspace/truncated',
          platform: 'electron',
        },
        name: 'truncated',
        path: '/workspace/truncated',
        rootFolderId: '/workspace',
        selectionState: 'unchecked',
        type: 'truncated',
      },
    ];
    const result = await tree.scan();
    expect(result.fileNodes).toEqual([]);
    expect([...result.truncatedDirectoryPaths]).toEqual(['/workspace']);
  });

  it('keeps hard agent rules above nested negation and keeps sibling scopes separate', async () => {
    const tree = fixture({
      '.llmignore': 'nested/secret.ts\n',
      'nested/.gitignore': 'drop.ts\n!secret.ts\n',
      'nested/drop.ts': 'excluded',
      'nested/secret.ts': 'private',
      'other/drop.ts': 'sibling',
    });
    expect((await tree.scan()).fileNodes.map((node) => node.path).sort()).toEqual([
      '/workspace/.llmignore',
      '/workspace/nested/.gitignore',
      '/workspace/other/drop.ts',
    ]);
  });

  it.each(['', 'big'])(
    'retains same-batch recreation under truncated %s without admitting its source',
    async (truncatedDirectory) => {
      const tree = fixture({ 'big/a.ts': 'recreated' });
      const readDirectory = tree.adapter.readDirectory;
      tree.adapter.readDirectory = async (handle) => {
        const nodes = await readDirectory(handle);
        if (handle.path === `/workspace${truncatedDirectory ? `/${truncatedDirectory}` : ''}`) {
          nodes.push({
            depth: 1,
            handle: {
              kind: 'file',
              name: 'truncated',
              path: `${handle.path}/truncated`,
              platform: 'electron',
            },
            name: 'truncated',
            path: `${handle.path}/truncated`,
            rootFolderId: '/workspace',
            selectionState: 'unchecked',
            type: 'truncated',
          });
        }
        return nodes;
      };
      const result = await tree.scan({
        changes: [
          { kind: 'file', path: '/workspace/big/a.ts', type: 'removed' },
          { kind: 'file', path: '/workspace/big/a.ts', type: 'added' },
        ],
        mode: 'paths',
      });
      expect(result.fileNodes).toEqual([]);
      expect(
        collectScopedRemovalInvalidations({
          existingEntries: [{ fileRecordId: 'cached-a', relativePath: 'big/a.ts', rootId: 'root' }],
          liveFilePaths: new Set(),
          pendingRemovals: result.pendingRemovals,
          rootId: 'root',
          truncatedDirectoryPrefixes: toTruncatedRelativePrefixes(
            result.truncatedDirectoryPaths,
            '/workspace'
          ),
        })
      ).toEqual([]);
    }
  );

  it('preserves explicit source read intent when an ignore edit promotes its watcher batch', async () => {
    const tree = fixture({ '.gitignore': '', 'a.ts': 'changed' });
    const result = await tree.scan({
      changes: [
        { kind: 'file', path: '/workspace/.gitignore', type: 'modified' },
        { kind: 'file', path: '/workspace/a.ts', type: 'modified' },
      ],
      mode: 'paths',
    });
    expect(result.scope.mode).toBe('full');
    expect([...result.forceReadRelativePaths].sort()).toEqual(['.gitignore', 'a.ts']);
  });
});
