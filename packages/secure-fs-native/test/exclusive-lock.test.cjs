'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { afterEach, test } = require('node:test');
const { tryExclusiveLock, waitForExclusiveLock } = require('..');

let directory;
const owned = [];
afterEach(() => {
  for (const child of owned.splice(0)) {
    child.kill('SIGKILL');
  }
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
  directory = undefined;
});
function lockFile() {
  directory = mkdtempSync(path.join(tmpdir(), 'bs-exclusive-lock-'));
  return path.join(directory, 'root.lock');
}
/** Whether a fresh handle could take the lock right now. */
function free(file) {
  const probe = tryExclusiveLock(file);
  probe?.release();
  return probe !== null;
}
/**
 * A process that takes the lock, starts `node -e process.stdin.resume()` on its
 * own stdin, prints the child's pid, then answers each line on its stdin with `alive`. Its stdin is this test's pipe,
 * so neither outlives the test however it ends.
 */
async function holder(file) {
  const script = `
const { spawn } = require('node:child_process');
const { tryExclusiveLock } = require(${JSON.stringify(path.join(__dirname, '..'))});
// Held by a global: a collected lock closes its handle.
globalThis.held = tryExclusiveLock(process.argv[1]);
if (globalThis.held === null) throw new Error('holder could not lock');
// Detached: on Windows libuv puts every other child in the parent's kill-on-close Job, so
// killing the holder would end this child too, and the test checks a child that outlives it.
const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { detached: true, stdio: ['inherit', 'ignore', 'inherit'] });
child.once('spawn', () => console.log(child.pid));
process.stdin.on('data', () => console.log('alive'));
`;
  const holding = spawn(process.execPath, ['-e', script, file], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  owned.push(holding);
  const lines = createInterface({ input: holding.stdout })[Symbol.asyncIterator]();
  const child = Number((await lines.next()).value);
  return { child, lines, process: holding };
}

test('rejects anything but one lock file path', () => {
  assert.throws(() => tryExclusiveLock(), TypeError);
  assert.throws(() => tryExclusiveLock(''), TypeError);
  assert.throws(() => tryExclusiveLock(1), TypeError);
  assert.throws(() => tryExclusiveLock('a\0b'), TypeError);
});

test('a second handle in this process is refused until the first releases', () => {
  const file = lockFile();
  const first = tryExclusiveLock(file);
  assert.notEqual(first, null);
  assert.equal(tryExclusiveLock(file), null);
  first.release();
  first.release();
  assert.equal(free(file), true);
});

test('a killed holder releases the lock while the child it started still runs', async () => {
  const file = lockFile();
  const { child, process: holding } = await holder(file);
  assert.equal(free(file), false, 'another process holds it');
  holding.kill('SIGKILL');
  await once(holding, 'exit');
  // The child shares the holder's stdin and is still running.
  process.kill(child, 0);
  assert.equal(free(file), true, 'the child never held the lock');
  holding.stdin.destroy();
});

test('a waiter takes the lock once its holder dies, and never before', async () => {
  const file = lockFile();
  const { lines, process: holding } = await holder(file);
  let settled = false;
  const waiting = waitForExclusiveLock(file).then((lock) => {
    settled = true;
    return lock;
  });
  // A round trip through the holder: the waiter is queued and the holder still runs.
  holding.stdin.write('ping\n');
  assert.equal((await lines.next()).value, 'alive');
  assert.equal(settled, false, 'the holder still holds the lock');
  holding.kill('SIGKILL');
  await once(holding, 'exit');
  const lock = await waiting;
  assert.equal(free(file), false, 'the waiter holds it');
  lock.release();
  assert.equal(free(file), true);
});

test('a free lock is taken at once, and a bad path rejects', async () => {
  const file = lockFile();
  const lock = await waitForExclusiveLock(file);
  assert.equal(tryExclusiveLock(file), null);
  lock.release();
  assert.equal(free(file), true);
  await assert.rejects(waitForExclusiveLock(''), TypeError);
});
