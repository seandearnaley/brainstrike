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
//
// `census <guardPid>` lists every member of the guard's Job (BST-2137): the
// JobObjectBasicProcessIdList PIDs with each member's image, parent PID,
// creation time and exit state, and the Job's active and total process counts.
// The first census also associates a completion port with that Job, so every
// later census includes the joins and exits recorded in between, each member
// described when it joined. The observer closes its Job handle before replying,
// so the guard's handle stays the last one and kill-on-close still ends the Job.
// `held <guardPid>` counts the guard's handles to each pinned process object,
// so a test can prove a resolved drain released the members it pinned.
const processObserverSource = `
param([string]$ProcessIds)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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
public static class JobCensus {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
 [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int information, IntPtr buffer, uint length, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int information, ref PortAssociation buffer, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr value, uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int information, IntPtr buffer, int length, out int returned);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [StructLayout(LayoutKind.Sequential)] struct PortAssociation { public IntPtr Key; public IntPtr Port; }
 static readonly IntPtr self = new IntPtr(-1);
 static readonly object gate = new object();
 static readonly ArrayList events = new ArrayList();
 static IntPtr port = IntPtr.Zero;
 static uint recorded;
 // PROCESS_HANDLE_SNAPSHOT_INFORMATION (ProcessHandleInformation, 51): a
 // 16-byte header, then 40-byte entries with HandleValue at 0 and
 // ObjectTypeIndex at 28.
 static int Entry(long index) { return checked((int)(16 + index * 40)); }
 static IntPtr Handles(IntPtr process, out long count) {
  int length = 0x10000;
  for (int attempt = 0; attempt < 8; attempt++) {
   IntPtr buffer = Marshal.AllocHGlobal(length);
   int returned;
   int status = NtQueryInformationProcess(process, 51, buffer, length, out returned);
   if (status == 0) { count = Marshal.ReadIntPtr(buffer).ToInt64(); return buffer; }
   Marshal.FreeHGlobal(buffer);
   if (status != unchecked((int)0xC0000004) && status != unchecked((int)0xC0000023)) throw new InvalidOperationException("ProcessHandleInformation failed with NTSTATUS 0x" + status.ToString("X8") + ".");
   length = Math.Max(length * 2, returned + 0x1000);
  }
  throw new InvalidOperationException("ProcessHandleInformation did not fit in eight attempts.");
 }
 static int TypeOf(IntPtr own) {
  long count;
  IntPtr table = Handles(self, out count);
  try {
   for (long i = 0; i < count; i++) {
    if (Marshal.ReadIntPtr(table, Entry(i)) == own) return Marshal.ReadInt32(table, Entry(i) + 28);
   }
  } finally { Marshal.FreeHGlobal(table); }
  throw new InvalidOperationException("The observer's own handle is missing from its handle table.");
 }
 static int JobType() {
  IntPtr own = CreateJobObject(IntPtr.Zero, null);
  if (own == IntPtr.Zero) throw new Win32Exception();
  try { return TypeOf(own); } finally { CloseHandle(own); }
 }
 static int ProcessType() {
  IntPtr own = OpenProcess(0x1000, false, GetCurrentProcessId());
  if (own == IntPtr.Zero) throw new Win32Exception();
  try { return TypeOf(own); } finally { CloseHandle(own); }
 }
 // How many handles the guard holds to each target process object. A handle
 // the guard closes between the snapshot and the duplicate is not held.
 public static int[] GuardHandlesTo(uint guardPid, IntPtr[] targets) {
  if (IntPtr.Size != 8) throw new InvalidOperationException("The Job census reads 64-bit layouts.");
  int processType = ProcessType();
  IntPtr guard = OpenProcess(0x1440, false, guardPid);
  if (guard == IntPtr.Zero) throw new Win32Exception();
  try {
   long count;
   IntPtr table = Handles(guard, out count);
   try {
    int[] held = new int[targets.Length];
    for (long i = 0; i < count; i++) {
     if (Marshal.ReadInt32(table, Entry(i) + 28) != processType) continue;
     IntPtr candidate;
     if (!DuplicateHandle(guard, Marshal.ReadIntPtr(table, Entry(i)), self, out candidate, 0, false, 2)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 6) continue;
      throw new Win32Exception(error);
     }
     try {
      for (int t = 0; t < targets.Length; t++) {
       if (CompareObjectHandles(candidate, targets[t])) held[t] += 1;
      }
     } finally { CloseHandle(candidate); }
    }
    return held;
   } finally { Marshal.FreeHGlobal(table); }
  } finally { CloseHandle(guard); }
 }
 static int LimitFlags(IntPtr job) {
  IntPtr limits = Marshal.AllocHGlobal(64);
  try {
   if (!QueryInformationJobObject(job, 2, limits, 64, IntPtr.Zero)) throw new Win32Exception();
   return Marshal.ReadInt32(limits, 16);
  } finally { Marshal.FreeHGlobal(limits); }
 }
 // A guard can hold handles to two Jobs that contain it. libuv also joins a
 // Node parent to its own kill-on-close Job when it first spawns an attached
 // child (uv__init_global_job_handle), and that Job permits silent breakaway.
 // The guard's initialize() Job permits no breakaway, and it is the Job whose
 // membership the drain proves.
 static IntPtr GuardJob(IntPtr guard, out int limitFlags) {
  int jobType = JobType();
  long count;
  IntPtr table = Handles(guard, out count);
  IntPtr found = IntPtr.Zero;
  limitFlags = 0;
  try {
   for (long i = 0; i < count; i++) {
    if (Marshal.ReadInt32(table, Entry(i) + 28) != jobType) continue;
    IntPtr candidate;
    if (!DuplicateHandle(guard, Marshal.ReadIntPtr(table, Entry(i)), self, out candidate, 0, false, 2)) throw new Win32Exception();
    bool keep = false;
    try {
     bool contains;
     if (!IsProcessInJob(guard, candidate, out contains)) throw new Win32Exception();
     if (!contains) continue;
     int flags = LimitFlags(candidate);
     if ((flags & 0x1800) != 0) continue;
     if (found != IntPtr.Zero) {
      if (CompareObjectHandles(found, candidate)) continue;
      throw new InvalidOperationException("The guard holds two different no-breakaway Jobs that contain it.");
     }
     found = candidate;
     limitFlags = flags;
     keep = true;
    } finally { if (!keep) CloseHandle(candidate); }
   }
  } catch {
   if (found != IntPtr.Zero) CloseHandle(found);
   throw;
  } finally { Marshal.FreeHGlobal(table); }
  if (found == IntPtr.Zero) throw new InvalidOperationException("The guard holds no no-breakaway Job that contains it.");
  return found;
 }
 static long[] Members(IntPtr job) {
  const int capacity = 4096;
  int length = 8 + capacity * 8;
  IntPtr list = Marshal.AllocHGlobal(length);
  try {
   Marshal.WriteInt32(list, 0, capacity);
   if (!QueryInformationJobObject(job, 3, list, (uint)length, IntPtr.Zero)) throw new Win32Exception();
   long[] ids = new long[Marshal.ReadInt32(list, 4)];
   for (int i = 0; i < ids.Length; i++) ids[i] = Marshal.ReadIntPtr(list, 8 + i * 8).ToInt64();
   return ids;
  } finally { Marshal.FreeHGlobal(list); }
 }
 static Hashtable Describe(long pid, IntPtr process, int openError) {
  Hashtable entry = new Hashtable();
  entry["pid"] = pid;
  if (process == IntPtr.Zero) { entry["openError"] = openError; return entry; }
  StringBuilder image = new StringBuilder(1024);
  uint size = (uint)image.Capacity;
  if (QueryFullProcessImageName(process, 0, image, ref size)) entry["image"] = image.ToString();
  else entry["imageError"] = Marshal.GetLastWin32Error();
  // PROCESS_BASIC_INFORMATION: InheritedFromUniqueProcessId is at 40.
  IntPtr basic = Marshal.AllocHGlobal(48);
  try {
   int returned;
   int status = NtQueryInformationProcess(process, 0, basic, 48, out returned);
   if (status == 0) entry["parentPid"] = Marshal.ReadIntPtr(basic, 40).ToInt64();
   else entry["parentError"] = "0x" + status.ToString("X8");
  } finally { Marshal.FreeHGlobal(basic); }
  long creation, exit, kernel, user;
  if (GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
   entry["start"] = creation.ToString();
   entry["startUtc"] = DateTime.FromFileTimeUtc(creation).ToString("o");
   if (exit != 0) entry["exitUtc"] = DateTime.FromFileTimeUtc(exit).ToString("o");
  } else entry["timesError"] = Marshal.GetLastWin32Error();
  entry["wait"] = WaitForSingleObject(process, 0);
  uint code;
  if (GetExitCodeProcess(process, out code)) entry["code"] = code;
  else entry["codeError"] = Marshal.GetLastWin32Error();
  return entry;
 }
 static string Message(uint message) {
  switch (message) {
   case 4: return "active-process-zero";
   case 6: return "new-process";
   case 7: return "exit-process";
   case 8: return "abnormal-exit-process";
   default: return "job-message-" + message;
  }
 }
 static void Listen() {
  try {
   while (true) {
    uint message;
    UIntPtr key;
    IntPtr value;
    if (!GetQueuedCompletionStatus(port, out message, out key, out value, 0xFFFFFFFF)) throw new Win32Exception();
    long pid = value.ToInt64();
    Hashtable entry;
    if (message == 6) {
     IntPtr process = OpenProcess(0x101000, false, (uint)pid);
     int error = Marshal.GetLastWin32Error();
     try { entry = Describe(pid, process, error); }
     finally { if (process != IntPtr.Zero) CloseHandle(process); }
    } else {
     entry = new Hashtable();
     entry["pid"] = pid;
    }
    entry["message"] = Message(message);
    entry["utc"] = DateTime.UtcNow.ToString("o");
    lock (gate) { events.Add(entry); }
   }
  } catch (Exception error) {
   Hashtable failure = new Hashtable();
   failure["message"] = "recorder-failed";
   failure["error"] = error.Message;
   failure["utc"] = DateTime.UtcNow.ToString("o");
   lock (gate) { events.Add(failure); }
  }
 }
 static void Record(IntPtr job, uint guardPid) {
  lock (gate) {
   if (port != IntPtr.Zero) {
    if (recorded != guardPid) throw new InvalidOperationException("This observer already records another guard's Job.");
    return;
   }
   IntPtr created = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
   if (created == IntPtr.Zero) throw new Win32Exception();
   PortAssociation association = new PortAssociation();
   association.Key = IntPtr.Zero;
   association.Port = created;
   if (!SetInformationJobObject(job, 7, ref association, (uint)Marshal.SizeOf(typeof(PortAssociation)))) {
    int error = Marshal.GetLastWin32Error();
    CloseHandle(created);
    throw new Win32Exception(error);
   }
   port = created;
   recorded = guardPid;
   Thread listener = new Thread(Listen);
   listener.IsBackground = true;
   listener.Start();
  }
 }
 public static Hashtable Census(uint guardPid) {
  if (IntPtr.Size != 8) throw new InvalidOperationException("The Job census reads 64-bit layouts.");
  IntPtr guard = OpenProcess(0x1440, false, guardPid);
  if (guard == IntPtr.Zero) throw new Win32Exception();
  try {
   int limitFlags;
   IntPtr job = GuardJob(guard, out limitFlags);
   try {
    Record(job, guardPid);
    long[] ids = Members(job);
    string listed = DateTime.UtcNow.ToString("o");
    IntPtr[] pinned = new IntPtr[ids.Length];
    int[] errors = new int[ids.Length];
    try {
     for (int i = 0; i < ids.Length; i++) {
      pinned[i] = OpenProcess(0x101000, false, (uint)ids[i]);
      errors[i] = Marshal.GetLastWin32Error();
     }
     Hashtable census = new Hashtable();
     census["utc"] = listed;
     census["limitFlags"] = "0x" + limitFlags.ToString("X");
     // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: TotalProcesses at 36,
     // ActiveProcesses at 40.
     IntPtr accounting = Marshal.AllocHGlobal(48);
     try {
      if (!QueryInformationJobObject(job, 1, accounting, 48, IntPtr.Zero)) throw new Win32Exception();
      census["totalProcesses"] = Marshal.ReadInt32(accounting, 36);
      census["activeProcesses"] = Marshal.ReadInt32(accounting, 40);
     } finally { Marshal.FreeHGlobal(accounting); }
     ArrayList members = new ArrayList();
     for (int i = 0; i < ids.Length; i++) members.Add(Describe(ids[i], pinned[i], errors[i]));
     census["members"] = members;
     lock (gate) {
      census["events"] = new ArrayList(events);
      events.Clear();
     }
     return census;
    } finally {
     foreach (IntPtr process in pinned) { if (process != IntPtr.Zero) CloseHandle(process); }
    }
   } finally { CloseHandle(job); }
  } finally { CloseHandle(guard); }
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
  if($line -match '^census ([0-9]+)$'){
   [Console]::WriteLine((@{event='census';census=[JobCensus]::Census([uint32]$Matches[1])} | ConvertTo-Json -Compress -Depth 8))
   continue
  }
  if($line -match '^held ([0-9]+)$'){
   $held=[JobCensus]::GuardHandlesTo([uint32]$Matches[1],[IntPtr[]]$handles)
   [Console]::WriteLine((@{event='held';held=@($held);identities=$identities} | ConvertTo-Json -Compress -Depth 4))
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
