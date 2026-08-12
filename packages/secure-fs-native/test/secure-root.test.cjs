'use strict';

const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { SecureRoot } = require('..');

let tempRoot;
afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { force: true, recursive: true });
    tempRoot = undefined;
  }
});

function fixture() {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-secure-fs-'));
  const workspace = path.join(tempRoot, 'workspace');
  const commands = path.join(workspace, '.brainstrike', 'commands');
  mkdirSync(commands, { recursive: true });
  writeFileSync(path.join(commands, 'review.md'), 'Inside workspace');
  return { commands, workspace };
}

test('lists metadata and reads regular files asynchronously beneath a pinned root', async () => {
  const { workspace } = fixture();
  const filePath = path.join(workspace, '.brainstrike', 'commands', 'review.md');
  const expected = statSync(filePath);
  const root = new SecureRoot(workspace);
  try {
    const pendingList = root.listDirAsync('.brainstrike/commands', 10);
    assert.equal(typeof pendingList.then, 'function');
    const listing = await pendingList;
    assert.deepEqual(listing, {
      entries: [
        {
          isDirectory: false,
          isFile: true,
          lastModified: expected.mtimeMs,
          name: 'review.md',
          size: expected.size,
        },
      ],
      inspected: 1,
      truncated: false,
    });
    const pendingRead = root.readFileAsync('.brainstrike/commands/review.md', 1024);
    assert.equal(typeof pendingRead.then, 'function');
    const result = await pendingRead;
    assert.equal(result.status, 'ok');
    assert.equal(result.content.toString('utf8'), 'Inside workspace');
  } finally {
    root.close();
  }
});

test('repeated and concurrent root listings each enumerate the complete directory', async () => {
  const { workspace } = fixture();
  const generatedNames = Array.from(
    { length: 600 },
    (_, index) => `entry-${String(index).padStart(4, '0')}-${'x'.repeat(80)}.txt`
  );
  for (const name of generatedNames) {
    writeFileSync(path.join(workspace, name), name);
  }
  const root = new SecureRoot(workspace);
  try {
    const [first, second] = await Promise.all([
      root.listDirAsync('.', 1000),
      root.listDirAsync('.', 1000),
    ]);
    const expectedNames = ['.brainstrike', ...generatedNames].sort();
    assert.deepEqual(first.entries.map((entry) => entry.name).sort(), expectedNames);
    assert.deepEqual(second.entries.map((entry) => entry.name).sort(), expectedNames);
    assert.deepEqual(
      root
        .listDir('.', 1000)
        .entries.map((entry) => entry.name)
        .sort(),
      expectedNames
    );
  } finally {
    root.close();
  }
});

test('reports a missing leaf distinctly from an unreadable path', async () => {
  const { commands, workspace } = fixture();
  rmSync(path.join(commands, 'review.md'));
  const root = new SecureRoot(workspace);
  try {
    assert.deepEqual(root.readFile('.brainstrike/commands/review.md', 1024), {
      status: 'not-found',
    });
    assert.deepEqual(await root.readFileAsync('.brainstrike/commands/review.md', 1024), {
      status: 'not-found',
    });
  } finally {
    root.close();
  }
});

test('bounds directory enumeration and reports truncation', () => {
  const { commands, workspace } = fixture();
  writeFileSync(path.join(commands, 'second.md'), 'Second');
  writeFileSync(path.join(commands, 'third.md'), 'Third');
  const root = new SecureRoot(workspace);
  try {
    const result = root.listDir('.brainstrike/commands', 2);
    assert.equal(result.entries.length, 2);
    assert.equal(result.inspected, 2);
    assert.equal(result.truncated, true);
  } finally {
    root.close();
  }
});

test('preserves literal POSIX backslashes between enumeration and read', {
  skip: process.platform === 'win32',
}, () => {
  const { commands, workspace } = fixture();
  writeFileSync(path.join(commands, 'literal\\name.md'), 'Literal backslash');
  mkdirSync(path.join(commands, 'literal'));
  writeFileSync(path.join(commands, 'literal', 'name.md'), 'Nested path');
  const root = new SecureRoot(workspace);
  try {
    const result = root.readFile('.brainstrike/commands/literal\\name.md', 1024);
    assert.equal(result.status, 'ok');
    assert.equal(result.content.toString('utf8'), 'Literal backslash');
  } finally {
    root.close();
  }
});

test('keeps authority on the opened root when its path is replaced', () => {
  const { workspace } = fixture();
  const parked = path.join(tempRoot, 'parked');
  const outside = path.join(tempRoot, 'outside');
  mkdirSync(path.join(outside, '.brainstrike', 'commands'), { recursive: true });
  writeFileSync(path.join(outside, '.brainstrike', 'commands', 'review.md'), 'Outside workspace');
  const root = new SecureRoot(workspace);
  try {
    renameSync(workspace, parked);
    symlinkSync(outside, workspace, 'dir');
    const result = root.readFile('.brainstrike/commands/review.md', 1024);
    assert.equal(result.status, 'ok');
    assert.equal(result.content.toString('utf8'), 'Inside workspace');
  } finally {
    root.close();
  }
});

test('rejects a command parent replaced with an outside symlink', () => {
  const { commands, workspace } = fixture();
  const parked = path.join(tempRoot, 'parked-commands');
  const outside = path.join(tempRoot, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'review.md'), 'Outside workspace');
  const root = new SecureRoot(workspace);
  try {
    renameSync(commands, parked);
    symlinkSync(outside, commands, 'dir');
    assert.equal(root.listDir('.brainstrike/commands', 10), null);
    assert.deepEqual(root.readFile('.brainstrike/commands/review.md', 1024), {
      status: 'unreadable',
    });
  } finally {
    root.close();
  }
});

test('rejects a leaf file replaced with an outside symlink', () => {
  const { commands, workspace } = fixture();
  const outside = path.join(tempRoot, 'outside.md');
  writeFileSync(outside, 'Outside workspace');
  rmSync(path.join(commands, 'review.md'));
  symlinkSync(outside, path.join(commands, 'review.md'), 'file');
  const root = new SecureRoot(workspace);
  try {
    assert.deepEqual(root.readFile('.brainstrike/commands/review.md', 1024), {
      status: 'unreadable',
    });
  } finally {
    root.close();
  }
});

test('rejects traversal and oversized content', () => {
  const { workspace } = fixture();
  const root = new SecureRoot(workspace);
  try {
    assert.equal(root.listDir('../', 10), null);
    assert.deepEqual(root.readFile('.brainstrike/commands/review.md', 4), {
      status: 'oversized',
    });
  } finally {
    root.close();
  }
});
