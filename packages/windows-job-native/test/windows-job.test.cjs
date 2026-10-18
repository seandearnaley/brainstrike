'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const windowsJob = require('..');
const { inbox, processObserverSource } = require('./command-job-fixture.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };

    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
    }
  });
}

test('observes a child that exited before the waiter attached', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  await waitForChildExit(child);
});

test('owns an orphaned late-writing grandchild without terminating an unrelated process', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-windows-job-test-'));
  const profile = path.join(root, 'profile');
  const readyPath = path.join(root, 'ready');
  const latePath = path.join(profile, 'late-write');
  await mkdir(profile);

  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    windowsJob.initialize();
    const grandchildSource = `
        const fs = require('node:fs');
        setTimeout(() => {
          fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true });
          fs.writeFileSync(${JSON.stringify(latePath)}, 'late');
        }, 700);
        setInterval(() => {}, 1000);
      `;
    const childSource = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
          detached: true,
          stdio: 'ignore',
        });
        grandchild.unref();
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      `;
    const child = spawn(process.execPath, ['-e', childSource], { stdio: 'ignore' });
    await waitForFile(readyPath);
    await waitForChildExit(child);

    assert.ok(windowsJob.activeProcessCount() > 1);
    assert.ok(windowsJob.terminateOtherProcesses(91) > 0);
    for (let attempts = 0; windowsJob.activeProcessCount() > 1 && attempts < 100; attempts += 1) {
      await sleep(25);
    }
    assert.equal(windowsJob.activeProcessCount(), 1);

    await rm(profile, { force: true, recursive: true });
    await sleep(900);
    await assert.rejects(stat(profile), { code: 'ENOENT' });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    unrelated.kill('SIGKILL');
    await waitForChildExit(unrelated);
    await rm(root, { force: true, recursive: true });
  }
});

test('kills inherited descendants when an owning launcher exits unexpectedly', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-windows-job-close-test-'));
  const profile = path.join(root, 'profile');
  const readyPath = path.join(root, 'ready');
  const latePath = path.join(profile, 'late-write');
  await mkdir(profile);

  try {
    const grandchildSource = `
        const fs = require('node:fs');
        setTimeout(() => {
          fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true });
          fs.writeFileSync(${JSON.stringify(latePath)}, 'late');
        }, 700);
        setInterval(() => {}, 1000);
      `;
    const helperSource = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const job = require(${JSON.stringify(path.resolve(__dirname, '..'))});
        job.initialize();
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
          detached: true,
          stdio: 'ignore',
        });
        grandchild.unref();
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        setTimeout(() => process.exit(0), 100);
      `;
    const helper = spawn(process.execPath, ['-e', helperSource], { stdio: 'ignore' });
    await waitForFile(readyPath);
    await waitForChildExit(helper);

    await rm(profile, { force: true, recursive: true });
    await sleep(900);
    await assert.rejects(stat(profile), { code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function drainFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-windows-job-drain-'));
  const guards = [];
  const observers = [];
  const controls = [];
  const observerPath = path.join(root, 'process-observer.ps1');
  await writeFile(observerPath, processObserverSource);
  const powershell = process.env.M3_WINDOWS_POWERSHELL || 'powershell.exe';
  t.after(async () => {
    // Keep external proof handles until guard teardown has physically joined its
    // admitted cohort. No timeout result is accepted as an exit signal.
    for (const guard of guards) {
      guard.child.kill('SIGKILL');
      await waitForChildExit(guard.child);
    }
    const failures = [];
    for (const observer of observers) {
      try {
        observer.child.stdin.write('join\n');
        const joined = await observer.wait('join');
        assert.ok(joined.waits.every((wait) => wait === 0));
      } catch (error) {
        failures.push(error);
      }
      observer.child.stdin.end('release\n');
      await waitForChildExit(observer.child);
      assert.equal(observer.child.exitCode, 0);
    }
    for (const control of controls) {
      control.kill('SIGKILL');
      await waitForChildExit(control);
    }
    if (failures.length) {
      throw new AggregateError(failures, `Drain cleanup unproved; preserved ${root}`);
    }
    await rm(root, { force: true, recursive: true });
  });
  return {
    // BST-2137: name every member of the guard's Job. The first census also
    // starts recording the Job's later joins and exits.
    census: async (observer, guardPid) => {
      observer.child.stdin.write(`census ${guardPid}\n`);
      return (await observer.wait('census')).census;
    },
    guard: (source) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
const job = require(${JSON.stringify(path.resolve(__dirname, '..'))});
(async () => { ${source} })().catch((error) => {
  process.send({ event: 'failed', message: error.stack });
});
`,
        ],
        { stdio: ['pipe', 'ignore', 'pipe', 'ipc'], windowsHide: true }
      );
      const actor = inbox(child);
      guards.push(actor);
      return actor;
    },
    observe: async (pids) => {
      const child = spawn(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', observerPath, pids.join(',')],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      const observer = inbox(child, true);
      observers.push(observer);
      const pinned = await observer.wait('pinned');
      assert.deepEqual(
        pinned.identities.map((identity) => identity.pid),
        pids
      );
      const directory = process.env.M3_WINDOWS_EVIDENCE_DIR;
      if (directory) {
        await appendFile(
          path.join(directory, 'native-drain-identities.jsonl'),
          `${JSON.stringify({ event: 'pinned-members', identities: pinned.identities, test: t.name, utc: new Date().toISOString() })}\n`
        );
      }
      return observer;
    },
    powershell,
    unrelated: () => {
      const child = spawn(
        process.execPath,
        ['-e', 'process.send({event:"ready"}); setInterval(() => {}, 1000);'],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
        }
      );
      controls.push(child);
      return inbox(child);
    },
  };
}

// One settlement event per drain, so a test that expects one outcome sees the
// other outcome and its message instead of timing out on a missing event. The
// UTC bounds place the census's recorded joins and exits relative to the drain.
const drainCommands = `
process.on('message', async ({ exitCode }) => {
 const startedUtc = new Date().toISOString();
 const pending = job.drainOtherProcesses(exitCode);
 try {
  const value = await pending;
  process.send({ event: 'settled', outcome: 'drained', valueIsUndefined: value === undefined, isPromise: pending instanceof Promise, count: job.activeProcessCount(), startedUtc, settledUtc: new Date().toISOString() });
 } catch(error) {
  process.send({ event: 'settled', outcome: 'rejected', message: error.message, count: job.activeProcessCount(), startedUtc, settledUtc: new Date().toISOString() });
 }
});
`;

// A drain that cannot prove the guard alone must name what else is in its Job
// (BST-2137). `before` is the census taken just before the drain; `after` lists
// the members once it settles, with the joins and exits recorded in between.
// After a rejection, `later` is taken a second afterwards and shows whether the
// extra member is still there, and when it left.
async function reportDrainCensus(t, fixture, observer, guardPid, before, settled) {
  const after = await fixture.census(observer, guardPid);
  let later;
  if (settled.outcome !== 'drained') {
    await sleep(1000);
    later = await fixture.census(observer, guardPid);
  }
  t.diagnostic(
    JSON.stringify({ after, before, event: 'drain-job-census', guardPid, later, settled })
  );
}

test('drain rejects uninitialized and invalid calls as Promises without admitting work', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  const guard = fixture.guard(`
const assert = require('node:assert/strict');
const missing = job.drainOtherProcesses(0);
assert.ok(missing instanceof Promise);
await assert.rejects(missing, /has not been initialized/);
job.initialize();
for (const args of [[], ['1'], [null], [0, 1]]) {
 const result = job.drainOtherProcesses(...args);
 assert.ok(result instanceof Promise);
 await assert.rejects(result, TypeError);
}
for (const exitCode of [-1, 0.5, NaN, Infinity, 4294967296]) {
 await assert.rejects(job.drainOtherProcesses(exitCode), RangeError);
}
assert.equal(job.activeProcessCount(), 1);
process.send({ event: 'verified' });
`);
  await guard.wait('verified');
});

test('drain asynchronously proves an already-alone guard and repeats with uint32 boundary codes', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  const guard = fixture.guard(`
const assert = require('node:assert/strict');
job.initialize();
for (const exitCode of [0, 4294967295, 259]) {
 let settled = false;
 const pending = job.drainOtherProcesses(exitCode).then((value) => { assert.equal(value, undefined); settled = true; });
 await Promise.resolve();
 assert.equal(settled, false);
 await pending;
 assert.equal(job.activeProcessCount(), 1);
}
process.send({ event: 'verified' });
`);
  await guard.wait('verified');
});

test('drain joins contained children with held external process handles and preserves an outside process', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  const control = fixture.unrelated();
  await control.wait('ready');
  const guard = fixture.guard(`
const { spawn } = require('node:child_process');
job.initialize();
const children = Array.from({length: 3}, () => spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], {stdio:['ignore','ignore','ignore','ipc']}));
await Promise.all(children.map((child) => new Promise((resolve) => child.once('message', resolve))));
process.send({event:'ready', pids:children.map((child) => child.pid), count:job.activeProcessCount()});
${drainCommands}
`);
  const ready = await guard.wait('ready');
  assert.equal(ready.count, 4);
  const observer = await fixture.observe(ready.pids);
  const before = await fixture.census(observer, guard.child.pid);
  guard.child.send({ exitCode: 259 });
  const settled = await guard.wait('settled');
  await reportDrainCensus(t, fixture, observer, guard.child.pid, before, settled);
  const { count, isPromise, message, outcome, valueIsUndefined } = settled;
  assert.deepEqual(
    { count, isPromise, message, outcome, valueIsUndefined },
    { count: 1, isPromise: true, message: undefined, outcome: 'drained', valueIsUndefined: true }
  );
  observer.child.stdin.write('check\n');
  const checked = await observer.wait('check');
  assert.deepEqual(checked.waits, [0, 0, 0]);
  assert.deepEqual(checked.codes, [259, 259, 259]);
  assert.doesNotThrow(() => process.kill(control.child.pid, 0));
  assert.doesNotThrow(() => process.kill(guard.child.pid, 0));
});

test('drain joins a detached orphan after its direct parent already exited', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  const grandchildSource = 'process.send(process.pid); setInterval(() => {}, 1000);';
  const parentSource = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']}); child.once('message',(pid)=>{process.send(pid); process.exit(0);});`;
  const guard = fixture.guard(`
const {spawn}=require('node:child_process');
job.initialize();
const child=spawn(process.execPath,['-e',${JSON.stringify(parentSource)}],{stdio:['ignore','ignore','ignore','ipc']});
const pid=await new Promise((resolve)=>child.once('message',resolve));
await new Promise((resolve)=>child.once('exit',resolve));
process.send({event:'ready',pids:[pid],parentExit:child.exitCode,count:job.activeProcessCount()});
${drainCommands}
`);
  const ready = await guard.wait('ready');
  assert.equal(ready.parentExit, 0);
  assert.equal(ready.count, 2);
  const observer = await fixture.observe(ready.pids);
  const before = await fixture.census(observer, guard.child.pid);
  guard.child.send({ exitCode: 91 });
  let settled;
  try {
    settled = await guard.wait('settled');
  } catch (error) {
    // An unsettled drain is a product hang, not a slow runner. Record whether
    // the pinned orphan was terminated so the failure names the stuck step.
    observer.child.stdin.write('check\n');
    const { codes, waits } = await observer.wait('check');
    throw new Error(`${error.message} Orphan: ${JSON.stringify({ codes, waits })}`, {
      cause: error,
    });
  }
  await reportDrainCensus(t, fixture, observer, guard.child.pid, before, settled);
  const { count, message, outcome } = settled;
  assert.deepEqual(
    { count, message, outcome },
    { count: 1, message: undefined, outcome: 'drained' }
  );
  observer.child.stdin.write('check\n');
  const checked = await observer.wait('check');
  assert.deepEqual(checked.waits, [0]);
  assert.deepEqual(checked.codes, [91]);
});

test('drain rejects denied cleanup while the guard and contained member remain physically live', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  // This changes only the disposable member's own process DACL and removes
  // SeDebugPrivilege from the disposable guard's token, which would otherwise
  // bypass that DACL on an elevated runner. It neither changes a global policy
  // nor asks for elevation. The existing kill-on-close Job still owns final
  // fixture cleanup.
  const guard = fixture.guard(`
const {spawn}=require('node:child_process');
job.initialize();
const child=spawn(process.execPath,['-e','process.send("ready"); setInterval(() => {}, 1000);'],{stdio:['ignore','ignore','ignore','ipc']});
await new Promise((resolve)=>child.once('message',resolve));
process.send({event:'ready',pids:[child.pid],count:job.activeProcessCount()});
${drainCommands}
`);
  const ready = await guard.wait('ready');
  assert.equal(ready.count, 2);
  const observer = await fixture.observe(ready.pids);
  observer.child.stdin.write('deny 0x1\n');
  await observer.wait('denied');
  observer.child.stdin.write(`restrict ${guard.child.pid}\n`);
  t.diagnostic(JSON.stringify(await observer.wait('restricted')));
  guard.child.send({ exitCode: 91 });
  const { count, message, outcome } = await guard.wait('settled');
  assert.deepEqual(
    { count, message, outcome },
    { count: 2, message: 'OpenProcess failed with Windows error 5.', outcome: 'rejected' }
  );
  observer.child.stdin.write('check\n');
  assert.deepEqual((await observer.wait('check')).waits, [258]);
  assert.doesNotThrow(() => process.kill(guard.child.pid, 0));
});

test('unsupported drain returns a rejected Promise', {
  skip: process.platform === 'win32',
}, async () => {
  const result = windowsJob.drainOtherProcesses(0);
  assert.ok(result instanceof Promise);
  await assert.rejects(result, /only available on Windows/);
});
