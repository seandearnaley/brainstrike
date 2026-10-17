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

// `deny <mask>` gives the first pinned member a DACL that denies <mask> to
// Everyone, administrators included. `restrict <pid>` removes SeDebugPrivilege
// from that actor's token, because OpenProcess ignores the DACL for it: "If the
// caller has enabled the SeDebugPrivilege privilege, the requested access is
// granted regardless of the contents of the security descriptor."
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess
// .NET enables it in any elevated process that uses System.Diagnostics.Process
// (the static ProcessManager constructor in dotnet/runtime), and a child copies
// its parent's token, so a .NET runner or pwsh hands it to the whole test tree.
// Together the two commands make a denial real for whoever runs the test. The
// reply reports the actor's prior state: absent, disabled or enabled.
const processObserverSource = `
param([string]$ProcessIds)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DrainProof {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out long luid);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref SinglePrivilege state, uint length, IntPtr previous, IntPtr returned);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int information, IntPtr buffer, uint length, out uint returned);
 [StructLayout(LayoutKind.Sequential, Pack=4)] struct SinglePrivilege { public uint Count; public long Luid; public uint Attributes; }
 static int Attributes(IntPtr token, long luid) {
  uint size;
  GetTokenInformation(token, 3, IntPtr.Zero, 0, out size);
  IntPtr buffer = Marshal.AllocHGlobal((int)size);
  try {
   if (!GetTokenInformation(token, 3, buffer, size, out size)) throw new Win32Exception();
   int count = Marshal.ReadInt32(buffer);
   for (int i = 0; i < count; i++) {
    if (Marshal.ReadInt64(buffer, 4 + i * 12) == luid) return Marshal.ReadInt32(buffer, 12 + i * 12);
   }
   return -1;
  } finally { Marshal.FreeHGlobal(buffer); }
 }
 public static string RemoveDebugPrivilege(uint pid) {
  long luid;
  if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out luid)) throw new Win32Exception();
  IntPtr process = OpenProcess(0x1000, false, pid);
  if (process == IntPtr.Zero) throw new Win32Exception();
  IntPtr token;
  if (!OpenProcessToken(process, 0x28, out token)) {
   int error = Marshal.GetLastWin32Error();
   CloseHandle(process);
   throw new Win32Exception(error);
  }
  try {
   int prior = Attributes(token, luid);
   if (prior != -1) {
    SinglePrivilege removal = new SinglePrivilege();
    removal.Count = 1; removal.Luid = luid; removal.Attributes = 4;
    if (!AdjustTokenPrivileges(token, false, ref removal, 0, IntPtr.Zero, IntPtr.Zero) || Marshal.GetLastWin32Error() != 0) throw new Win32Exception();
   }
   if (Attributes(token, luid) != -1) throw new InvalidOperationException("SeDebugPrivilege remains in the actor token.");
   return prior == -1 ? "absent" : ((prior & 2) != 0 ? "enabled" : "disabled");
  } finally {
   CloseHandle(token);
   CloseHandle(process);
  }
 }
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
  if($line -match '^deny (0x[0-9a-f]+)$'){
   $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new("D:(D;;$($Matches[1]);;;WD)(A;;GA;;;WD)")
   $bytes=[byte[]]::new($descriptor.BinaryLength);$descriptor.GetBinaryForm($bytes,0)
   if(![DrainProof]::SetKernelObjectSecurity($handles[0],4,$bytes)){throw 'Cannot set owned member DACL'}
   [Console]::WriteLine((@{event='denied';identities=$identities} | ConvertTo-Json -Compress -Depth 4))
   continue
  }
  if($line -match '^restrict ([0-9]+)$'){
   $prior=[DrainProof]::RemoveDebugPrivilege([uint32]$Matches[1])
   [Console]::WriteLine((@{event='restricted';pid=[int]$Matches[1];debugPrivilege=$prior} | ConvertTo-Json -Compress))
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
module.exports = { commandFixture, inbox, processObserverSource, waitForChildExit };
