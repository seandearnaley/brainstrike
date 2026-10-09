'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { closeSync, constants, mkdtempSync, openSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { afterEach, test } = require('node:test');
const { tryExclusiveFlock } = require('..');

const posix = process.platform !== 'win32';
let directory;
const owned = [];
afterEach(() => {
  for (const pid of owned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
  directory = undefined;
});
function lockFile() {
  directory = mkdtempSync(path.join(tmpdir(), 'bs-flock-'));
  return path.join(directory, 'root.flock');
}
const open = (file) => openSync(file, constants.O_RDWR | constants.O_CREAT, 0o600);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};
async function gone(pid) {
  while (alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const probe = (file) => {
  const fd = open(file);
  try {
    return tryExclusiveFlock(fd);
  } finally {
    closeSync(fd);
  }
};

test('rejects anything but one descriptor', () => {
  assert.throws(() => tryExclusiveFlock(), TypeError);
  assert.throws(() => tryExclusiveFlock(-1), TypeError);
  assert.throws(() => tryExclusiveFlock(1.5), TypeError);
});

test('Windows reports flock as unsupported', { skip: posix }, () => {
  assert.throws(() => tryExclusiveFlock(0), { code: 'ENOTSUP' });
});

test('one open file description excludes another until it closes', { skip: !posix }, () => {
  const file = lockFile();
  const first = open(file);
  assert.equal(tryExclusiveFlock(first), true);
  assert.equal(tryExclusiveFlock(first), true, 'the holder may re-assert its own lock');
  assert.equal(probe(file), false);
  closeSync(first);
  assert.equal(probe(file), true);
});

test('a descendant that inherited the descriptor holds the lock after its holder is SIGKILLed', {
  skip: !posix,
}, async () => {
  const file = lockFile();
  // The holder locks, starts a detached SIGTERM-immune command with the
  // descriptor as its fd 3 (libuv dup2s it, clearing close-on-exec), reports
  // the command's pid, then waits to be killed.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `
const { spawn } = require('node:child_process');
const { constants, openSync } = require('node:fs');
const { tryExclusiveFlock } = require(${JSON.stringify(path.join(__dirname, '..'))});
const fd = openSync(process.argv[1], constants.O_RDWR | constants.O_CREAT, 0o600);
if (!tryExclusiveFlock(fd)) throw new Error('holder could not lock');
const command = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', fd],
});
console.log(command.pid);
setInterval(() => {}, 1000);
`,
      file,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  owned.push(holder.pid);
  const [line] = await once(createInterface({ input: holder.stdout }), 'line');
  const command = Number(line);
  owned.push(command);
  assert.equal(probe(file), false);
  process.kill(holder.pid, 'SIGKILL');
  await once(holder, 'exit');
  assert.equal(alive(command), true);
  assert.equal(probe(file), false, 'the surviving command still holds the lock');
  process.kill(command, 'SIGTERM');
  assert.equal(probe(file), false, 'a SIGTERM-immune command keeps it');
  process.kill(command, 'SIGKILL');
  await gone(command);
  assert.equal(probe(file), true);
});
