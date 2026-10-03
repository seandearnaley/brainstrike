import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildDirectoryListing,
  descriptorFor,
  MAX_DIRECTORY_ENTRIES,
} from '@brainstrike/file-system/workspace-root-nodes';

assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
const rootId = 'public-projection-root';
const rootPath = path.resolve('fixture-root');
assert.equal(MAX_DIRECTORY_ENTRIES, 10_000);
assert.deepEqual(descriptorFor({ addedAt: 0, path: rootPath, rootId }, 'granted', false), {
  displayName: 'fixture-root',
  handle: {
    kind: 'directory',
    name: 'fixture-root',
    path: rootPath,
    platform: 'electron',
    rootId,
  },
  kind: 'path',
  permissionState: 'granted',
  persisted: false,
  rootId,
});
const entries = Object.freeze([
  Object.freeze({ isDirectory: false, isFile: true, isSymbolicLink: false, name: 'z.txt' }),
  Object.freeze({ isDirectory: true, isFile: false, isSymbolicLink: true, name: 'a-link' }),
  Object.freeze({ isDirectory: true, isFile: false, isSymbolicLink: false, name: 'z-dir' }),
  Object.freeze({
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    lastModified: 0,
    name: 'b.txt',
    size: 0,
  }),
  Object.freeze({ isDirectory: true, isFile: false, isSymbolicLink: false, name: 'a-dir' }),
]);
const nodes = buildDirectoryListing({ rootId }, rootPath, {
  entries,
  inspected: MAX_DIRECTORY_ENTRIES,
  truncated: true,
});
assert.deepEqual(
  nodes.map((node) => node.name),
  ['a-dir', 'z-dir', 'a-link', 'b.txt', 'z.txt', 'Showing first 10,000 entries']
);
for (const node of nodes) {
  assert.equal(node.rootFolderId, rootId);
  assert.equal(node.handle.rootId, rootId);
  assert.equal(path.dirname(node.path), rootPath);
}
assert.deepEqual(nodes[0].children, []);
assert.equal(nodes[2].type, 'file');
assert.equal(nodes[2].isSymbolicLink, true);
assert.equal(nodes[2].children, undefined);
assert.equal(nodes[3].lastModified, 0);
assert.equal(nodes[3].size, 0);
assert.equal(Object.hasOwn(nodes[4], 'lastModified'), false);
assert.equal(Object.hasOwn(nodes[4], 'size'), false);
assert.equal(nodes[5].type, 'truncated');
assert.equal(nodes[5].path, path.join(rootPath, '…truncated…'));
process.stdout.write(
  `${JSON.stringify({ metadata: true, nodeEntry: true, noFollowShape: true, retainedRootIdentity: true, truncationVisible: true })}\n`
);
