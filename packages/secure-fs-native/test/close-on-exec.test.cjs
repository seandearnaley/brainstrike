'use strict';

// Node marks the descriptors it inherits close-on-exec at startup, so a Node test cannot hold one without the flag.
// The desktop's app-owned host test proves the effect: the host Main spawns holds none of Main's descriptors.
const assert = require('node:assert/strict');
const { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { markDescriptorsCloseOnExec } = require('..');

test('rejects arguments', () => {
  assert.throws(() => markDescriptorsCloseOnExec(1), TypeError);
});

test('this process keeps using its own descriptors', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bs-cloexec-'));
  try {
    const file = path.join(directory, 'own');
    const fd = openSync(file, 'w');
    markDescriptorsCloseOnExec();
    writeSync(fd, 'kept');
    closeSync(fd);
    assert.equal(readFileSync(file, 'utf8'), 'kept');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
