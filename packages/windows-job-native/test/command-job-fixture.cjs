'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFile, mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
          const index = messages.findIndex((entry) => entry.event === event);
          const message = index < 0 ? undefined : messages[index];
          if (error) {
            failed(new Error(error.message));
          } else if (message) {
            cleanup();
            messages.splice(index, 1);
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

async function collectCleanupErrors(callbacks, failures) {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      failures.push(error);
    }
  }
}

async function commandFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-command-job-'));
  const guards = [];
  const beforeGuardTeardown = [];
  const afterGuardTeardown = [];
  const observers = [];
  const observerPath = path.join(root, 'process-observer.ps1');
  await writeFile(observerPath, processObserverSource);
  t.after(async () => {
    const failures = [];
    await collectCleanupErrors(beforeGuardTeardown, failures);
    for (const guard of guards) {
      if (guard.child.exitCode === null && guard.child.signalCode === null) {
        guard.child.send({ type: 'quit' });
      }
      await waitForChildExit(guard.child);
    }
    await collectCleanupErrors(afterGuardTeardown, failures);
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
    if (failures.length) {
      throw new AggregateError(failures, `Physical cleanup unproved; preserved ${root}`);
    }
    await rm(root, { force: true, recursive: true });
  });
  return {
    afterGuards(finish) {
      afterGuardTeardown.push(finish);
    },
    beforeGuards(release) {
      beforeGuardTeardown.push(release);
    },
    guard(source, extraEnvironment = {}) {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          '-e',
          'const job=require(' +
            JSON.stringify(path.resolve(__dirname, '..')) +
            ');' +
            'process.on("message",(message)=>{if(message.type==="quit")process.exit(0);});' +
            '(async()=>{' +
            source +
            '})().catch(error=>process.send({event:"failed",message:error.stack}));',
        ],
        {
          cwd: root,
          env: { ...process.env, ...extraEnvironment },
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        }
      );
      const guard = inbox(child);
      guards.push(guard);
      return guard;
    },
    async observe(pids) {
      const child = spawn(
        process.env.M3_WINDOWS_POWERSHELL || 'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', observerPath, pids.join(',')],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const observer = inbox(child, true);
      observers.push(observer);
      const pinned = await observer.wait('pinned');
      observer.pinned = pinned;
      assert.deepEqual(
        pinned.identities.map((identity) => identity.pid),
        pids
      );
      if (process.env.M3_WINDOWS_EVIDENCE_DIR) {
        await appendFile(
          path.join(process.env.M3_WINDOWS_EVIDENCE_DIR, 'command-job-identities.jsonl'),
          `${JSON.stringify({
            event: 'pinned-members',
            identities: pinned.identities,
            test: t.name,
            utc: new Date().toISOString(),
          })}\n`
        );
      }
      return observer;
    },
    root,
  };
}
module.exports = { commandFixture, inbox, waitForChildExit };
