'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const job = require('..');

const linux = process.platform === 'linux';
const packageRoot = path.resolve(__dirname, '..');
const source = path.join(packageRoot, 'src/linux-process-observer.cc');
const fixtures = path.join(__dirname, 'fixtures');
let root;
let ownerProgram;
let faults;
const unjoined = new Set();

function compile(compiler, args) {
  execFileSync(compiler, args, { stdio: 'pipe' });
}

before(() => {
  if (!linux) {
    return;
  }
  root = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-linux-observer-'));
  ownerProgram = path.join(root, 'owner');
  compile('cc', [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-pthread',
    path.join(fixtures, 'linux-process-owner.c'),
    '-o',
    ownerProgram,
  ]);
  const configuration = JSON.parse(
    readFileSync(path.join(packageRoot, 'build/config.gypi'), 'utf8').replace(/^#.*$/gm, '')
  );
  const nodeHeaders = configuration.variables.nodedir;
  const common = [
    '-std=c++17',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fPIC',
    '-DNAPI_CPP_EXCEPTIONS',
    `-I${path.join(nodeHeaders, 'include/node')}`,
    `-I${path.dirname(require.resolve('node-addon-api'))}`,
  ];
  const object = path.join(root, 'observer.o');
  compile('c++', [
    ...common,
    '-Dsyscall=ObserverFixtureSyscall',
    '-Dopen=ObserverFixtureOpen',
    '-Dread=ObserverFixtureRead',
    '-Dclose=ObserverFixtureClose',
    '-Dpoll=ObserverFixturePoll',
    '-c',
    source,
    '-o',
    object,
  ]);
  const addon = path.join(root, 'faults.node');
  compile('c++', [
    ...common,
    '-shared',
    object,
    path.join(fixtures, 'linux-observer-faults.cc'),
    '-o',
    addon,
  ]);
  faults = require(addon);
});

after(() => {
  assert.equal(unjoined.size, 0, `Unproved fixture join; retained ${root}`);
  if (root) {
    rmSync(root, { recursive: true });
  }
});

function readStart(pid) {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function pidfds() {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`).includes('pidfd');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }).length;
}

async function owner(t) {
  const directory = mkdtempSync(path.join(root, 'owner-'));
  const writer = path.join(directory, 'retained-writer');
  const child = spawn(ownerProgram, [writer], { stdio: ['pipe', 'pipe', 'pipe'] });
  unjoined.add(child);
  const messages = [];
  let output = '';
  let stderr = '';
  let failure;
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  child.stdout.on('data', (data) => {
    output += data.toString();
    let newline = output.indexOf('\n');
    while (newline !== -1) {
      messages.push(JSON.parse(output.slice(0, newline)));
      output = output.slice(newline + 1);
      child.emit('fixture-message');
      newline = output.indexOf('\n');
    }
  });
  child.on('error', (error) => {
    failure = error;
  });
  const joined = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    child.stdin.end();
    await joined;
    assert.ifError(failure);
    assert.equal(child.exitCode, 0, stderr);
    assert.equal(child.signalCode, null);
    unjoined.delete(child);
    rmSync(directory, { recursive: true });
  });
  const wait = (event) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('fixture-message', check);
        child.off('close', check);
        child.off('error', check);
      };
      const check = () => {
        const index = messages.findIndex((message) => message.event === event);
        if (index !== -1) {
          cleanup();
          resolve(messages.splice(index, 1)[0]);
        } else if (failure || child.exitCode !== null || child.signalCode !== null) {
          cleanup();
          reject(failure || new Error(`Fixture closed before ${event}: ${stderr}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Fixture did not report ${event}: ${stderr}`));
      }, 5000);
      child.on('fixture-message', check);
      child.once('close', check);
      child.once('error', check);
      check();
    });
  const ready = await wait('ready');
  return {
    child,
    command: async (command, event) => {
      child.stdin.write(`${command}\n`);
      return wait(event);
    },
    joined,
    pid: ready.pid,
    wait,
    writer,
  };
}

test('public observer loads and observes a live process without leaking descriptors', {
  skip: !linux,
}, () => {
  const start = readStart(process.pid);
  const beforeCount = pidfds();
  let reads = 0;
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(
      job.observeLinuxProcess(process.pid, start, (pid) => {
        assert.equal(pid, process.pid);
        reads += 1;
        return readStart(pid);
      }),
      { pid: process.pid, start, state: 'live' }
    );
  }
  assert.equal(reads, 20);
  assert.equal(pidfds(), beforeCount);
});

test('pthread_exit leader stays live and writable until the whole group exits, before reaping', {
  skip: !linux,
}, async (t) => {
  const fixture = await owner(t);
  const start = readStart(fixture.pid);
  const state = execFileSync('ps', ['-o', 'stat=', '-p', String(fixture.pid)], {
    encoding: 'utf8',
  }).trim();
  assert.ok(state.startsWith('Z'), state);
  assert.deepEqual(job.observeLinuxProcess(fixture.pid, start, readStart), {
    pid: fixture.pid,
    start,
    state: 'live',
  });
  await fixture.command('W', 'written');
  assert.equal(readFileSync(fixture.writer, 'utf8'), 'worker alive\n');
  await fixture.command('Q', 'exited');
  assert.equal(readStart(fixture.pid), start);
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(job.observeLinuxProcess(fixture.pid, start, readStart), {
      pid: fixture.pid,
      start,
      state: 'exited',
    });
  }
  await fixture.command('R', 'reaped');
  await fixture.joined;
  let read = false;
  assert.deepEqual(
    job.observeLinuxProcess(fixture.pid, start, () => {
      read = true;
    }),
    { pid: fixture.pid, state: 'missing' }
  );
  assert.equal(read, false);
});

test('surviving worker exec retains creation identity and a live writable group', {
  skip: !linux,
}, async (t) => {
  const fixture = await owner(t);
  const start = readStart(fixture.pid);
  await fixture.command('E', 'execed');
  assert.equal(readStart(fixture.pid), start);
  assert.deepEqual(job.observeLinuxProcess(fixture.pid, start, readStart), {
    pid: fixture.pid,
    start,
    state: 'live',
  });
  await fixture.command('W', 'written');
  assert.equal(readFileSync(fixture.writer, 'utf8'), 'worker alive\n');
  await fixture.command('Q', 'exited');
  assert.deepEqual(job.observeLinuxProcess(fixture.pid, start, readStart), {
    pid: fixture.pid,
    start,
    state: 'exited',
  });
});

test('rejects invalid inputs and unavailable, asynchronous or different creation identity', {
  skip: !linux,
}, () => {
  const start = readStart(process.pid);
  for (const args of [
    [],
    [process.pid, start],
    ['1', start, readStart],
    [process.pid, null, readStart],
  ]) {
    assert.throws(() => job.observeLinuxProcess(...args), TypeError);
  }
  for (const pid of [-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => job.observeLinuxProcess(pid, start, readStart), RangeError);
  }
  assert.throws(() => job.observeLinuxProcess(process.pid, 'unknown', readStart), TypeError);
  const beforeCount = pidfds();
  for (const observed of [null, undefined, '', 'unknown', Promise.resolve(start)]) {
    assert.throws(() => job.observeLinuxProcess(process.pid, start, () => observed), {
      code: 'ERR_LINUX_PROCESS_OBSERVER',
    });
  }
  // A different persisted birth string must not authorize polling this current
  // process as the old lease owner. Same-second historical reuse remains outside
  // this leaf's identity contract.
  assert.throws(
    () => job.observeLinuxProcess(process.pid, 'Thu Jan  1 00:00:00 1970', readStart),
    /does not match/
  );
  const original = new Error('creation reader failed');
  assert.throws(
    () =>
      job.observeLinuxProcess(process.pid, start, () => {
        throw original;
      }),
    (error) => error === original
  );
  assert.equal(pidfds(), beforeCount);
});

test('one flags0 pidfd brackets identity and poll with all descriptors closed', {
  skip: !linux,
}, () => {
  const start = readStart(process.pid);
  faults.configure('');
  assert.deepEqual(faults.observeLinuxProcess(process.pid, start, readStart), {
    pid: process.pid,
    start,
    state: 'live',
  });
  assert.deepEqual(faults.counters(), {
    owned: 0,
    pidfdCalls: 1,
    pidfdCloseAttempts: 1,
    pidfdFlags: 0,
    pollCalls: 1,
  });
});

test('unsupported, permission, namespace, raced identity, poll and close failures stay unknown', {
  skip: !linux,
}, () => {
  const start = readStart(process.pid);
  const beforeCount = pidfds();
  for (const fault of [
    'unsupported',
    'permission',
    'exhausted',
    'namespace',
    'metadata-error',
    'reaped-during-reader',
    'poll-error',
    'poll-interrupted',
    'poll-invalid',
    'poll-unknown',
    'close-error',
    'close-interrupted',
  ]) {
    faults.configure(fault);
    assert.throws(
      () => faults.observeLinuxProcess(process.pid, start, readStart),
      { code: 'ERR_LINUX_PROCESS_OBSERVER' },
      fault
    );
    const counters = faults.counters();
    assert.equal(counters.owned, 0, fault);
    const unopened = ['unsupported', 'permission', 'exhausted', 'namespace'].includes(fault);
    assert.equal(counters.pidfdCloseAttempts, unopened ? 0 : 1, fault);
    if (unopened || ['metadata-error', 'reaped-during-reader'].includes(fault)) {
      assert.equal(counters.pollCalls, 0, fault);
    }
  }
  assert.equal(pidfds(), beforeCount);
});

test('observer is unavailable off Linux without changing Windows Job exports', {
  skip: linux,
}, () => {
  assert.throws(
    () => job.observeLinuxProcess(1, 'Thu Jan  1 00:00:00 1970', () => null),
    /only available on Linux/
  );
});
