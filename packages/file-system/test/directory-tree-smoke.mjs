import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFullTreeWithOptions } from '@brainstrike/file-system/directory-tree';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { build, stop } from 'esbuild';

assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
const rootPath = await mkdtemp(path.join(tmpdir(), 'brainstrike-directory-tree-'));
const rootId = 'artifact-root';
const adapter = new ElectronFileSystemAdapter({ cache: false });
try {
  await mkdir(path.join(rootPath, 'src'));
  await mkdir(path.join(rootPath, 'node_modules'));
  await writeFile(path.join(rootPath, 'README.md'), 'Canonical original text.\n');
  await writeFile(path.join(rootPath, 'src/index.ts'), 'export const value = 1;\n');
  await writeFile(path.join(rootPath, 'node_modules/ignored.ts'), 'export const ignored = 1;\n');
  const reads = [];
  const tree = await readFullTreeWithOptions(
    {
      async readDirectory(handle, options) {
        reads.push({ path: handle.path, rootId: handle.rootId });
        return adapter.readDirectory(handle, options);
      },
    },
    {
      kind: 'directory',
      name: 'fixture',
      path: rootPath,
      platform: 'electron',
      rootId,
    },
    { concurrency: 2, propagateDirectoryReadErrors: true }
  );
  assert.deepEqual(
    tree.map((node) => node.name),
    ['src', 'README.md']
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.name),
    ['index.ts']
  );
  assert.equal(tree[1].size, Buffer.byteLength('Canonical original text.\n'));
  assert.equal(typeof tree[1].lastModified, 'number');
  assert.equal(reads.length, 2);
  assert.equal(
    reads.every((read) => read.rootId === rootId),
    true
  );

  const browser = await build({
    bundle: true,
    entryPoints: ['@brainstrike/file-system/directory-tree'],
    format: 'esm',
    metafile: true,
    platform: 'browser',
    write: false,
  });
  assert.equal(browser.outputFiles.length, 1);
  assert.equal(browser.outputFiles[0].contents.byteLength > 0, true);
  assert.equal(
    Object.keys(browser.metafile.inputs).some((input) =>
      /file-explorer-ui|\/react(?:-dom)?\//u.test(input)
    ),
    false
  );
  process.stdout.write(
    `${JSON.stringify({ browserBundle: true, nativeReads: reads.length, nodeEntry: true, retainedRootIdentity: true })}\n`
  );
} finally {
  await stop();
  await rm(rootPath, { force: true, recursive: true });
}
