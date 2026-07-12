'use strict';

const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
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

test('lists and reads regular files beneath a pinned root', () => {
  const { workspace } = fixture();
  const root = new SecureRoot(workspace);
  try {
    assert.deepEqual(root.listDir('.brainstrike/commands', 10), {
      entries: [{ isDirectory: false, isFile: true, name: 'review.md' }],
      inspected: 1,
      truncated: false,
    });
    const result = root.readFile('.brainstrike/commands/review.md', 1024);
    assert.equal(result.status, 'ok');
    assert.equal(result.content.toString('utf8'), 'Inside workspace');
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
