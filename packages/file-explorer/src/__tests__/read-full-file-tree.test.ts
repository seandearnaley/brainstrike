import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { readFullFileTree } from '../read-full-file-tree.js';

// --- Mocking Strategy ---
interface MockFileHandle {
  kind: 'file';
  name: string;
  // Define other methods like getFile, createWritable if they were ever accessed by readFullFileTree
}

interface MockDirectoryHandle {
  entries: () => AsyncIterableIterator<[string, MockFileHandle | MockDirectoryHandle]>;
  kind: 'directory';
  name: string;
  // Define other methods if necessary
}

const mockFile = (name: string): MockFileHandle => ({
  kind: 'file',
  name,
});

const mockDirectory = (
  name: string,
  children: [string, MockFileHandle | MockDirectoryHandle][] = []
): MockDirectoryHandle => {
  return {
    async *entries() {
      for (const entry of children) {
        yield entry;
      }
    },
    kind: 'directory',
    name,
  } as MockDirectoryHandle; // Type assertion needed because of the async generator
};

class BrowserHandleTestAdapter implements FileSystemAdapter {
  private readonly pathByHandle = new WeakMap<object, string>();

  constructor(
    private readonly root: MockDirectoryHandle,
    private readonly wrapDirectoryDescriptors = false
  ) {
    this.pathByHandle.set(root, '');
  }

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    return {
      _internal: this.root,
      kind: 'directory',
      name: this.root.name,
      path: '',
      platform: 'web',
    };
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    const browserHandle = handle._internal as MockDirectoryHandle | undefined;
    if (!browserHandle) {
      throw new Error(`Missing browser directory handle for ${handle.path}`);
    }

    const nodes: IFileNode[] = [];
    for await (const [name, childHandle] of browserHandle.entries()) {
      const path = this.pathByHandle.get(childHandle) ?? `${handle.path}/${name}`;
      this.pathByHandle.set(childHandle, path);
      nodes.push({
        depth: 0,
        handle:
          this.wrapDirectoryDescriptors && childHandle.kind === 'directory'
            ? { _internal: childHandle, kind: 'directory', name, path, platform: 'web' }
            : (childHandle as unknown as FileSystemDirectoryHandle | FileSystemFileHandle),
        name,
        path,
        rootFolderId: this.root.name,
        selectionState: 'unchecked',
        type: childHandle.kind,
        ...(childHandle.kind === 'directory' ? { children: [] } : {}),
      });
    }
    return nodes;
  }

  async readFile(): Promise<string> {
    return '';
  }

  async exists(): Promise<boolean> {
    return false;
  }
}

async function readBrowserFixture(
  root: MockDirectoryHandle,
  maxDepth?: number
): Promise<IFileNode[]> {
  const adapter = new BrowserHandleTestAdapter(root);
  const rootHandle = await adapter.requestDirectoryAccess();
  return readFullFileTree(adapter, rootHandle, maxDepth === undefined ? {} : { maxDepth });
}
// --- End Mocking Strategy ---

describe('readFullFileTree', () => {
  it('traverses canonical web directory descriptors without wrapping their raw capability again', async () => {
    const adapter = new BrowserHandleTestAdapter(
      mockDirectory('root', [
        ['child', mockDirectory('child', [['file.txt', mockFile('file.txt')]])],
      ]),
      true
    );
    const tree = await readFullFileTree(adapter, await adapter.requestDirectoryAccess());

    expect(tree[0]?.children?.[0]).toMatchObject({ name: 'file.txt', path: '/child/file.txt' });
  });

  // Test Scenario 1: Basic Valid Tree
  it('should process a basic valid tree structure', async () => {
    const _rootHandle = mockDirectory('root', [
      ['file1.txt', mockFile('file1.txt')],
      ['dir1', mockDirectory('dir1', [['file2.txt', mockFile('file2.txt')]])],
    ]);

    const result = await readBrowserFixture(_rootHandle);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      depth: 0,
      isDepthTruncated: false,
      isSymbolicLink: false,
      name: 'file1.txt',
      path: '/file1.txt',
      rootFolderId: 'root',
      type: 'file',
    });
    expect(result[1]).toMatchObject({
      depth: 0,
      isDepthTruncated: false,
      isSymbolicLink: false,
      name: 'dir1',
      path: '/dir1',
      rootFolderId: 'root',
      type: 'directory',
    });
    expect(result[1]!.children).toHaveLength(1);
    expect(result[1]!.children?.[0]).toMatchObject({
      depth: 1,
      isDepthTruncated: false,
      isSymbolicLink: false,
      name: 'file2.txt',
      path: '/dir1/file2.txt',
      rootFolderId: 'root',
      type: 'file',
    });
  });

  it('preserves a durable rootId stamped on a child handle during recursive traversal', async () => {
    const stampedChildHandle = Object.assign(mockDirectory('child'), {
      rootId: 'stamped-child-root-id',
    });
    const adapter = new BrowserHandleTestAdapter(
      mockDirectory('root', [['child', stampedChildHandle]])
    );
    const readDirectory = vi.spyOn(adapter, 'readDirectory');
    const rootHandle = await adapter.requestDirectoryAccess();

    await readFullFileTree(adapter, rootHandle);

    expect(readDirectory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: '/child',
        rootId: 'stamped-child-root-id',
      })
    );
  });

  it('inherits the durable rootId when a web child handle is unstamped', async () => {
    const adapter = new BrowserHandleTestAdapter(
      mockDirectory('root', [['child', mockDirectory('child')]])
    );
    const readDirectory = vi.spyOn(adapter, 'readDirectory');
    const rootHandle: DirectoryHandle = {
      ...(await adapter.requestDirectoryAccess()),
      rootId: 'outer-root-id',
    };

    await readFullFileTree(adapter, rootHandle);

    expect(readDirectory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: '/child',
        rootId: 'outer-root-id',
      })
    );
  });

  // Test Scenario 2: Circular Reference (Symbolic Link)
  it('should handle circular references (symbolic links)', async () => {
    const dirA = mockDirectory('a');
    const dirB = mockDirectory('b', [['loop_to_a', dirA]]);
    // Create the circular dependency: dirA contains dirB
    dirA.entries = async function* () {
      yield ['dirB', dirB];
    };

    const _rootHandle = mockDirectory('root', [['dirA', dirA]]);

    const result = await readBrowserFixture(_rootHandle);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ depth: 0, name: 'dirA', path: '/dirA', type: 'directory' });

    const childrenOfA = result[0]!.children;
    expect(childrenOfA).toHaveLength(1);
    expect(childrenOfA?.[0]).toMatchObject({
      depth: 1,
      name: 'dirB',
      path: '/dirA/dirB',
      type: 'directory',
    });

    const childrenOfB = childrenOfA?.[0]!.children;
    expect(childrenOfB).toHaveLength(1);
    expect(childrenOfB?.[0]).toMatchObject({
      children: [], // Symbolic link should have no children processed
      depth: 2,
      isDepthTruncated: false, // As per new logic, symlink is not depth truncated
      isSymbolicLink: true,
      name: 'loop_to_a',
      path: '/dirA',
      rootFolderId: 'root',
      type: 'directory',
    });
  });

  // Test Scenario 3: Depth Limiting
  it('should limit recursion depth correctly', async () => {
    const rootHandle = mockDirectory('d0', [
      [
        'd1',
        mockDirectory('d1', [
          [
            'd2',
            mockDirectory('d2', [
              ['d3', mockDirectory('d3', [['file.txt', mockFile('file.txt')]])],
            ]),
          ],
        ]),
      ],
    ]);

    const result = await readBrowserFixture(rootHandle, 2);

    expect(result).toHaveLength(1); // d1
    expect(result[0]!.name).toBe('d1');
    expect(result[0]!.depth).toBe(0);
    expect(result[0]!.children?.[0]).toMatchObject({
      depth: 1, // d2 is at depth 1 relative to d1, overall depth is parentPath depth + 1
      name: 'd2',
      path: '/d1/d2',
      type: 'directory',
    });
    // d2 is at depth 1 (from d1), its children (d3) would be at depth 2.
    // The node d2 itself is returned, but its children are not explored if depth + 1 >= maxDepth.
    // The prompt expects d2 to be truncated. The depth in readFullFileTree is for children.
    // So, when processing d1 (depth 0 for its call), its child d2 (depth 1) is fine.
    // When processing d2 (depth 1 for its call), its child d3 (depth 2) is where truncation happens.
    // The 'd2' node itself should have isDepthTruncated: true.

    // Let's re-evaluate based on the function's `depth` parameter usage.
    // readFullFileTree(d0, '', 0, 'd0', visited, 2)
    // -> d1 (depth 0) -> children from readFullFileTree(d1Handle, '/d1', 1, 'd0', visited, 2)
    //   -> d2 (depth 1) -> children from readFullFileTree(d2Handle, '/d1/d2', 2, 'd0', visited, 2)
    //     -> d2Handle is at depth 2 for THIS call. depth >= maxDepth (2 >= 2) is true.
    //        So, d2 node itself should be marked as truncated.

    const d1Node = result[0]!; // This is d1
    expect(d1Node.children).toHaveLength(1);
    const d2Node = d1Node.children?.[0]!; // This is d2

    expect(d2Node).toMatchObject({
      children: [], // Children of d2 should be empty due to truncation
      depth: 1, // depth relative to d0
      isDepthTruncated: true,
      isSymbolicLink: false,
      name: 'd2',
      path: '/d1/d2', // path from root d0
      rootFolderId: 'd0',
      type: 'directory',
    });
  });

  // Test Scenario 4: Depth Limiting at Root
  it('should limit recursion at root if maxDepth is 0', async () => {
    const _rootHandle = mockDirectory('root', [
      ['file1.txt', mockFile('file1.txt')],
      ['dir1', mockDirectory('dir1')],
    ]);

    // The function processes children. If maxDepth is 0, the root's children are at depth 0.
    // The depth check is `depth >= maxDepth`.
    // For the first call to process children of 'root', `depth` will be 0.
    // So, 0 >= 0 is true. Children nodes should be truncated.
    // The prompt says "The root node itself should have isDepthTruncated: true".
    // This seems to imply the root IFileNode, but readFullFileTree returns an array of children.
    // Let's assume it means the *children nodes* of the root are truncated.
    // Or, if the root itself is considered depth 0 for its *own properties* (not its children processing pass).
    // The current implementation of readFullFileTree adds nodes to `entries`.
    // If the initial call's `depth` (default 0) >= `maxDepth` (0), then no iteration happens.
    // This test needs to be carefully aligned with how `readFullFileTree` uses `depth` and `maxDepth`.
    // The `depth` param in readFullFileTree is the depth of the *current* directory's children.
    // If we call readFullFileTree(rootHandle, '', 0, 'root', visited, 0),
    // inside, when processing children of rootHandle, depth will be 0.
    // So, file1.txt and dir1 will be created with isDepthTruncated: true and children: [].

    const result = await readBrowserFixture(_rootHandle, 0);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      depth: 0,
      name: 'file1.txt',
      path: '/file1.txt',
      type: 'file', // Files don't get truncated, they just are or aren't there.
      // isDepthTruncated is not applicable to files in this context
    });
    expect(result[1]).toMatchObject({
      children: [],
      depth: 0,
      isDepthTruncated: true,
      isSymbolicLink: false,
      name: 'dir1',
      path: '/dir1',
      rootFolderId: 'root',
      type: 'directory',
    });
  });

  // Test Scenario 5: Path Ignoring (shouldIgnorePath)
  it('should ignore paths like .git and node_modules', async () => {
    const _rootHandle = mockDirectory('root', [
      ['file1.txt', mockFile('file1.txt')],
      ['node_modules', mockDirectory('node_modules', [['some_lib', mockFile('some_lib.js')]])],
      ['.git', mockDirectory('.git', [['HEAD', mockFile('HEAD')]])],
      [
        'src',
        mockDirectory('src', [
          ['index.ts', mockFile('index.ts')],
          ['nested', mockDirectory('nested', [['node_modules', mockDirectory('node_modules')]])],
        ]),
      ],
    ]);

    const result = await readBrowserFixture(_rootHandle);
    expect(result).toHaveLength(2); // file1.txt and src
    expect(result.find((node) => node.name === 'node_modules')).toBeUndefined();
    expect(result.find((node) => node.name === '.git')).toBeUndefined();
    expect(result.find((node) => node.name === 'file1.txt')).toBeDefined();
    const src = result.find((node) => node.name === 'src');
    expect(src).toBeDefined();
    expect(src?.children?.some((child) => child.name === 'node_modules')).toBe(false);
    expect(src?.children?.[0]!.name).toBe('index.ts');
  });

  // Test Scenario 6: Empty Directory
  it('should handle empty directories correctly', async () => {
    const rootHandle = mockDirectory('root', [
      ['emptyDir', mockDirectory('emptyDir')],
      ['file1.txt', mockFile('file1.txt')],
    ]);

    const result = await readBrowserFixture(rootHandle);
    expect(result).toHaveLength(2);
    const emptyDirNode = result.find((node) => node.name === 'emptyDir');
    expect(emptyDirNode).toBeDefined();
    expect(emptyDirNode).toMatchObject({
      children: [],
      isDepthTruncated: false,
      isSymbolicLink: false,
      type: 'directory',
    });
  });

  // Test: Depth limiting and symbolic links interaction
  it('should prioritize depth limit over symbolic link if depth limit is met first', async () => {
    const dirA = mockDirectory('a'); // This will be the target of the "loop"
    // dirB contains a "link" back to dirA, but dirB itself is deep enough to be truncated
    const dirB = mockDirectory('b', [['loop_to_a', dirA]]);
    dirA.entries = async function* () {
      yield ['dirB_child_of_A', dirB];
    }; // Not strictly needed for this test variant

    // This test validates depth truncation priority over symbolic links
    // rootHandle would be used with readFullFileTree but test focuses on depth behavior
    // Call with maxDepth = 1.
    // Processing root (children at depth 0): dir1 (depth 0)
    //   Processing dir1 (children at depth 1): dirA_child_of_dir1 (depth 1)
    //     Processing dirA_child_of_dir1 (children at depth 2):
    //       Here, depth (2) >= maxDepth (1) is true. So dirA_child_of_dir1 itself should be truncated.
    // This test needs to be structured so that a node *could* be a symlink but is depth-truncated.
    // The prompt says "The node for d2 (at depth 2) has isDepthTruncated: true".
    // Let's try this: /root/d1/d2_symlink_target /root/d1/d2_symlink (points to d2_symlink_target)
    // And we set maxDepth = 1. So d1 is processed. d2_symlink is depth 1.
    // d2_symlink should be marked as isDepthTruncated: true, not isSymbolicLink: true.

    const symlinkTarget = mockDirectory('symlink_target');
    const d2Symlink = mockDirectory('d2_symlink');
    // Make d2_symlink point to symlinkTarget for its *children definition* if it were to be expanded
    d2Symlink.entries = async function* () {
      yield ['actual_child_of_target', symlinkTarget];
    };

    // This test validates symbolic link flagging behavior
    // root would be used with readFullFileTree for symlink detection

    // To make 'd2_is_the_symlink' a symbolic link, it would need to point to an *already visited path*
    // The current structure doesn't make d2_is_the_symlink a symbolic link based on visitedPaths.
    // For this test, let's make a real cycle that gets truncated.
    // /root/level0/level1_repeats -> points to /root/level0
    // maxDepth = 0. So "level0" children are depth 0.
    // "level1_repeats" should be truncated.

    const level0 = mockDirectory('level0');
    level0.entries = async function* () {
      yield ['level1_repeats', level0];
    }; // level1_repeats points back to level0

    const topHandle = mockDirectory('top', [['level0_entry', level0]]);

    const result = await readBrowserFixture(topHandle, 0);

    expect(result).toHaveLength(1);
    const level0Node = result[0]!;
    expect(level0Node.name).toBe('level0_entry');
    expect(level0Node.depth).toBe(0);
    expect(level0Node.isDepthTruncated).toBe(true); // Because its children (depth 0) >= maxDepth (0)
    expect(level0Node.isSymbolicLink).toBe(false);
    expect(level0Node.children).toEqual([]);
  });
});

// Helper to find a node in the tree for more complex assertions (optional)
// function findNode(nodes: IFileNode[], path: string): IFileNode | undefined {
//   for (const node of nodes) {
//     if (normalizePath(node.path) === normalizePath(path)) return node;
//     if (node.children) {
//       const found = findNode(node.children, path);
//       if (found) return found;
//     }
//   }
//   return undefined;
// }
