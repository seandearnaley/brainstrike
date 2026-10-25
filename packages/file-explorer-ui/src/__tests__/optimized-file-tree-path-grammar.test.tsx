import { buildQuerySelectionManifest } from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act } from '@brainstrike/test-utils/react-act';
import { createEmptySelectionModel, type IFileNode } from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { type FileExplorerStore, StoreHandleBridge } from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

/**
 * A desktop tree's paths are its host's native paths (Main joins them with
 * `path.join`), so a Windows tree is separated by `\`. The same tree and the
 * same selection must check the same folders under either grammar.
 */
const GRAMMARS = [
  { name: 'POSIX', root: '/Users/test/project', separator: '/' },
  { name: 'Windows', root: 'C:\\Users\\test\\project', separator: '\\' },
] as const;

const FOLDER_ID = 'root-id-path-grammar';

function nativeTree(root: string, separator: string) {
  const join = (...segments: string[]) => [root, ...segments].join(separator);
  const file = (name: string, path: string, depth: number): IFileNode => ({
    depth,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path,
    rootFolderId: FOLDER_ID,
    selectionState: 'unchecked',
    type: 'file',
  });
  const directory = (name: string, path: string, depth: number, children: IFileNode[]) =>
    ({
      children,
      depth,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name,
      path,
      rootFolderId: FOLDER_ID,
      selectionState: 'unchecked',
      type: 'directory',
    }) as IFileNode;
  const files = {
    index: join('hooks', 'src', 'index.ts'),
    manifest: join('hooks', 'package.json'),
  };
  const tree = [
    directory('hooks', join('hooks'), 0, [
      directory('src', join('hooks', 'src'), 1, [file('index.ts', files.index, 2)]),
      file('package.json', files.manifest, 1),
    ]),
  ];
  return { files, join, tree };
}

async function renderTree(tree: IFileNode[]): Promise<FileExplorerStore> {
  let store: FileExplorerStore | undefined;
  render(
    <FileExplorerTestWrapper>
      <StoreHandleBridge
        onStoreReady={(ready) => {
          store = ready;
        }}
      />
      <OptimizedFileTree fileTree={tree} folderId={FOLDER_ID} loadingFiles={new Set()} />
    </FileExplorerTestWrapper>
  );
  await act(async () => {
    await Promise.resolve();
  });
  if (!store) {
    throw new Error('File explorer store is unavailable in test');
  }
  return store;
}

/** Open collapsed folders, outermost first, until `src`'s file row is mounted. */
async function expandAll(): Promise<void> {
  while (!screen.queryByLabelText('Select index.ts')) {
    const [expand] = screen.getAllByLabelText('Expand');
    await act(async () => {
      fireEvent.click(expand as HTMLElement);
      await Promise.resolve();
    });
  }
}

describe.each(GRAMMARS)('folder checkboxes over $name paths', ({ root, separator }) => {
  it('check every folder whose files are all explicitly selected', async () => {
    const { files, tree } = nativeTree(root, separator);
    const store = await renderTree(tree);

    await act(async () => {
      store
        .getState()
        .setSelectedFiles(
          new Set([
            encodeFileSelection(FOLDER_ID, files.manifest),
            encodeFileSelection(FOLDER_ID, files.index),
          ])
        );
      store.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
    await expandAll();

    expect(screen.getByLabelText('Select hooks')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
  });

  it('count selected files under a folder that has not loaded yet', async () => {
    const { files, join, tree } = nativeTree(root, separator);
    const [hooks] = tree;
    if (!hooks?.children) {
      throw new Error('The fixture tree lost its hooks folder');
    }
    const unloaded = {
      ...hooks,
      children: hooks.children.map((child) =>
        child.name === 'src'
          ? ({ ...child, children: [], loadState: 'unloaded' } as IFileNode)
          : child
      ),
    };
    const store = await renderTree([unloaded]);

    await act(async () => {
      store
        .getState()
        .setSelectedFiles(
          new Set([
            encodeFileSelection(FOLDER_ID, files.manifest),
            encodeFileSelection(FOLDER_ID, join('hooks', 'src', 'index.ts')),
          ])
        );
      store.getState().setSelectionMode('explicit');
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Expand')[0] as HTMLElement);
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'indeterminate');
  });

  it.each([
    { manifest: 'not loaded yet', ready: false },
    { manifest: 'scanned', ready: true },
  ])(
    'check the folders a query selection covers when its manifest is $manifest',
    async ({ ready }) => {
      const { files, join, tree } = nativeTree(root, separator);
      const store = await renderTree(tree);
      const filePaths = [files.manifest, files.index];

      await act(async () => {
        store.setState({
          querySelectionManifest: ready
            ? buildQuerySelectionManifest({
                filePaths,
                fingerprint: 'query-fingerprint',
                snapshotId: 'query-snapshot',
              })
            : null,
          selectionModel: {
            ...createEmptySelectionModel(),
            materializedAt: new Date(0).toISOString(),
            materializedPaths: new Set(filePaths),
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: [join('hooks'), join('hooks', 'src')],
              excludedPaths: [],
              excludeFilters: [],
              folderId: FOLDER_ID,
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-folder',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: ready ? 'query-snapshot' : 'missing-snapshot-id',
              rootPath: join('hooks'),
              totalSelectedCount: filePaths.length,
              useRegex: false,
            },
          },
        });
        await Promise.resolve();
      });
      await expandAll();

      expect(screen.getByLabelText('Select hooks')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Select src')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Select index.ts')).toHaveAttribute('data-state', 'checked');
    }
  );
});
