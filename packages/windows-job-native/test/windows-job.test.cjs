'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const windowsJob = require('..');

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

function inbox(child, stdout = false) {
  const messages = [];
  let output = '';
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  const receive = (message) => {
    messages.push(message);
    child.emit('fixture-message');
  };
  if (stdout) {
    child.stdout.on('data', (data) => {
      output += data.toString();
      let newline = output.indexOf('\n');
      while (newline !== -1) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line) {
          receive(JSON.parse(line));
        }
        newline = output.indexOf('\n');
      }
    });
  } else {
    child.on('message', receive);
  }
  return {
    child,
    wait: (event) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.off('fixture-message', check);
          child.off('exit', exited);
          child.off('error', failed);
        };
        const failed = (error) => {
          cleanup();
          reject(error);
        };
        const exited = () => failed(new Error(`Fixture exited before ${event}: ${stderr}`));
        const check = () => {
          const error = messages.find((message) => message.event === 'failed');
          const message = messages.find((entry) => entry.event === event);
          if (error) {
            failed(new Error(error.message));
          } else if (message) {
            cleanup();
            resolve(message);
          }
        };
        const timer = setTimeout(
          () => failed(new Error(`Timed out waiting for ${event}: ${stderr}`)),
          5000
        );
        child.on('fixture-message', check);
        child.once('exit', exited);
        child.once('error', failed);
        check();
        if (child.exitCode !== null || child.signalCode !== null) {
          exited();
        }
      }),
  };
}

const processObserverSource = `
param([string]$ProcessIds)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DrainProof {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
}
'@
$handles=@();$identities=@()
try {
 foreach($targetId in $ProcessIds.Split(',')) {
  $handle=[DrainProof]::OpenProcess(0x141000,$false,[uint32]$targetId)
  if($handle -eq [IntPtr]::Zero){throw 'Cannot pin owned process'}
  $handles+=,$handle
  [long]$creation=0;[long]$exit=0;[long]$kernel=0;[long]$user=0
  if(![DrainProof]::GetProcessTimes($handle,[ref]$creation,[ref]$exit,[ref]$kernel,[ref]$user)){throw 'Cannot read pinned creation time'}
  $identities+=@{pid=[int]$targetId;start=$creation.ToString()}
 }
 [Console]::WriteLine((@{event='pinned';identities=$identities} | ConvertTo-Json -Compress -Depth 4))
 while($null -ne ($line=[Console]::ReadLine())) {
  if($line -eq 'release'){break}
  if($line -eq 'deny'){
   $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new('D:(D;;0x1;;;WD)(A;;GA;;;WD)')
   $bytes=[byte[]]::new($descriptor.BinaryLength);$descriptor.GetBinaryForm($bytes,0)
   if(![DrainProof]::SetKernelObjectSecurity($handles[0],4,$bytes)){throw 'Cannot set owned member DACL'}
   [Console]::WriteLine((@{event='denied';identities=$identities} | ConvertTo-Json -Compress -Depth 4))
   continue
  }
  if($line -notin @('check','join')){throw 'Unexpected observer command'}
  $waits=@(foreach($handle in $handles){[DrainProof]::WaitForSingleObject($handle,$(if($line -eq 'join'){5000}else{0}))})
  $codes=@(foreach($handle in $handles){[uint32]$code=0;if(![DrainProof]::GetExitCodeProcess($handle,[ref]$code)){throw 'Cannot read pinned exit code'};$code})
  [Console]::WriteLine((@{event=$line;waits=$waits;codes=$codes;identities=$identities} | ConvertTo-Json -Compress -Depth 4))
 }
} finally { foreach($handle in $handles){[void][DrainProof]::CloseHandle($handle)} }
`;

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

const drainCommands = `
process.on('message', async ({ exitCode }) => {
 try {
  const pending = job.drainOtherProcesses(exitCode);
  const value = await pending;
  process.send({ event: 'drained', valueIsUndefined: value === undefined, isPromise: pending instanceof Promise, count: job.activeProcessCount() });
 } catch(error) {
  process.send({ event: 'rejected', message: error.message, count: job.activeProcessCount() });
 }
});
`;

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
  guard.child.send({ exitCode: 259 });
  assert.deepEqual(await guard.wait('drained'), {
    count: 1,
    event: 'drained',
    isPromise: true,
    valueIsUndefined: true,
  });
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
  guard.child.send({ exitCode: 91 });
  assert.equal((await guard.wait('drained')).count, 1);
  observer.child.stdin.write('check\n');
  const checked = await observer.wait('check');
  assert.deepEqual(checked.waits, [0]);
  assert.deepEqual(checked.codes, [91]);
});

test('drain rejects denied cleanup while the guard and contained member remain physically live', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await drainFixture(t);
  // This changes only the disposable member's own process DACL. It neither
  // changes a global policy nor asks for elevation/debug privileges. The
  // existing kill-on-close Job still owns final fixture cleanup.
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
  observer.child.stdin.write('deny\n');
  await observer.wait('denied');
  guard.child.send({ exitCode: 91 });
  const rejected = await guard.wait('rejected');
  assert.match(rejected.message, /OpenProcess failed with Windows error 5/);
  assert.equal(rejected.count, 2);
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
