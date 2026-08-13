'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { SecureRoot } = require('..');

let tempRoot;
let cleanupPaths = [];
afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { force: true, recursive: true });
    tempRoot = undefined;
  }
  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath, { force: true, recursive: true });
  }
  cleanupPaths = [];
});

function fixture() {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-secure-fs-'));
  const workspace = path.join(tempRoot, 'workspace');
  const commands = path.join(workspace, '.brainstrike', 'commands');
  mkdirSync(commands, { recursive: true });
  writeFileSync(path.join(commands, 'review.md'), 'Inside workspace');
  return { commands, workspace };
}

test('exposes a constructible named export through dynamic import', async () => {
  const imported = await import('../index.cjs');
  assert.equal(imported.SecureRoot, SecureRoot);
});

test('lists metadata and reads regular files asynchronously beneath a pinned root', async () => {
  const { workspace } = fixture();
  const filePath = path.join(workspace, '.brainstrike', 'commands', 'review.md');
  const expected = statSync(filePath);
  const root = new SecureRoot(workspace);
  try {
    assert.equal(root.canonicalPath, realpathSync.native(workspace));
    const pendingList = root.listDirAsync('.brainstrike/commands', 10);
    assert.equal(typeof pendingList.then, 'function');
    const listing = await pendingList;
    // The native layer carries full 100ns FILETIME precision on Windows while
    // Node's mtimeMs rounds differently in the sub-millisecond digits, so
    // compare timestamps with a 1ms epsilon rather than exact doubles.
    const { lastModified, ...entryRest } = listing.entries[0];
    assert.ok(
      Math.abs(lastModified - expected.mtimeMs) < 1,
      `lastModified ${lastModified} differs from mtimeMs ${expected.mtimeMs} by >= 1ms`
    );
    assert.deepEqual(
      { ...listing, entries: [entryRest] },
      {
        entries: [
          {
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
            name: 'review.md',
            size: expected.size,
          },
        ],
        inspected: 1,
        truncated: false,
      }
    );
    const pendingRead = root.readFileAsync('.brainstrike/commands/review.md', 1024);
    assert.equal(typeof pendingRead.then, 'function');
    const result = await pendingRead;
    assert.equal(result.status, 'ok');
    assert.equal(result.content.toString('utf8'), 'Inside workspace');
  } finally {
    root.close();
  }
});

test('lists symlinks explicitly but never follows them', async () => {
  const { commands, workspace } = fixture();
  const outside = path.join(tempRoot, 'outside.md');
  writeFileSync(outside, 'Outside workspace');
  symlinkSync('review.md', path.join(commands, 'inside-link.md'), 'file');
  symlinkSync(outside, path.join(commands, 'outside-link.md'), 'file');
  symlinkSync('outside-link.md', path.join(commands, 'chained-link.md'), 'file');
  symlinkSync('missing.md', path.join(commands, 'dangling-link.md'), 'file');
  const root = new SecureRoot(workspace);
  try {
    const listing = await root.listDirAsync('.brainstrike/commands', 10);
    for (const name of [
      'inside-link.md',
      'outside-link.md',
      'chained-link.md',
      'dangling-link.md',
    ]) {
      assert.deepEqual(
        listing.entries.find((entry) => entry.name === name),
        {
          isDirectory: false,
          isFile: false,
          isSymbolicLink: true,
          name,
        }
      );
      assert.deepEqual(await root.readFileAsync(`.brainstrike/commands/${name}`, 1024), {
        status: 'unreadable',
      });
    }
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

test('rejects non-finite and fractional bounds without entering native I/O', async () => {
  const { workspace } = fixture();
  const root = new SecureRoot(workspace);
  try {
    assert.equal(root.listDir('.', Number.NaN), null);
    assert.equal(await root.listDirAsync('.', Number.POSITIVE_INFINITY), null);
    assert.deepEqual(root.readFile('.brainstrike/commands/review.md', 1.5), {
      status: 'unreadable',
    });
    assert.deepEqual(await root.readFileAsync('.brainstrike/commands/review.md', Number.NaN), {
      status: 'unreadable',
    });
  } finally {
    root.close();
  }
});

test('derives canonical identity from the opened handle for a symlinked root path', () => {
  const { workspace } = fixture();
  const alias = mkdtempSync(path.join(tmpdir(), 'brainstrike-secure-fs-alias-'));
  rmSync(alias, { force: true, recursive: true });
  symlinkSync(workspace, alias, 'dir');
  cleanupPaths.push(alias);
  const root = new SecureRoot(alias);
  try {
    // Identity must come from the pinned handle: the symlink alias resolves
    // to the workspace's canonical path, not to the alias string.
    assert.equal(root.canonicalPath, realpathSync.native(workspace));
    const listing = root.listDir('.', 100);
    assert.ok(listing);
    assert.ok(listing.entries.some((entry) => entry.name === '.brainstrike'));
    // canonicalPath is a getter with no setter: the module runs in strict
    // mode, so assigning to it must throw rather than silently no-op.
    assert.throws(() => {
      root.canonicalPath = '/tmp/hijacked';
    }, TypeError);
    assert.equal(root.canonicalPath, realpathSync.native(workspace));
  } finally {
    root.close();
  }
});

test('throws when the root path does not exist', () => {
  assert.throws(() => new SecureRoot('/nonexistent/path/xyz'), {
    message: 'Failed to open secure filesystem root',
  });
});

test('close drains a blocked read without waiting on a mutex held across I/O', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const { commands, workspace } = fixture();
  const fifoPath = path.join(commands, 'pipe.fifo');
  execFileSync('mkfifo', [fifoPath]);
  const root = new SecureRoot(workspace);

  // openat(parent, 'pipe.fifo', O_RDONLY|O_NOFOLLOW) blocks in the kernel
  // until a writer opens the FIFO. The worker acquires its RootHandle
  // snapshot before making that blocking call.
  let settled = false;
  const pending = root.readFileAsync('.brainstrike/commands/pipe.fifo', 1024);
  pending.then(() => {
    settled = true;
  });
  // Give the worker time to reach the blocked open.
  await sleep(100);

  const before = process.hrtime.bigint();
  root.close();
  const closeMs = Number(process.hrtime.bigint() - before) / 1e6;
  // Discriminating assertion: under the old mutex-across-I/O design,
  // close() blocks on the mutex the worker is holding for the entire
  // blocked open, i.e. until a writer shows up — this bound would time
  // out the whole test (see the `timeout` option above) rather than pass.
  // Under the new design close() only swaps the state pointer.
  assert.ok(closeMs < 1000, `close() took ${closeMs}ms`);

  // New operations after close fail closed immediately.
  assert.equal(root.listDir('.', 10), null);
  assert.deepEqual(root.readFile('.brainstrike/commands/pipe.fifo', 1024), {
    status: 'unreadable',
  });

  // Release the blocked worker (unless close() already won a rare race
  // and the read observed the revocation before ever blocking).
  if (!settled) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const writerFd = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
        closeSync(writerFd);
        break;
      } catch (error) {
        if (error.code !== 'ENXIO' || Date.now() > deadline) {
          throw error;
        }
        await sleep(10);
      }
    }
  }

  // The drained read ran to completion against the pinned object: the
  // open succeeds once a writer appears, then fstat rejects the
  // non-regular file.
  const result = await pending;
  assert.equal(result.status, 'unreadable');
});
