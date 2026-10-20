import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyPrivateDirectorySync } from '@brainstrike/secure-fs-native';
import { afterEach, expect, test } from 'vitest';
import { publishHostRecord, readHostRecord, removeOwnHostRecord } from '../src/record-file.js';
import { startHost } from '../src/runtime.js';
import { verifyWindowsPrivateDirectory } from '../src/windows-acl.js';
import { type AclKind, windowsPrivateAcl } from './fixtures/powershell-acl.js';

const execute = promisify(execFile);
const roots: string[] = [];
const windowsTest = test.skipIf(process.platform !== 'win32');
const inspectCommand = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$identityType = [System.Security.Principal.SecurityIdentifier]
$path = $env:BRAINSTRIKE_ACL_TEST_PATH
if ($env:BRAINSTRIKE_ACL_TEST_KIND -eq 'directory') {
  $info = [System.IO.DirectoryInfo]::new($path)
} else {
  $info = [System.IO.FileInfo]::new($path)
}
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$acl = $info.GetAccessControl($sections)
switch ($env:BRAINSTRIKE_ACL_TEST_MUTATION) {
  'extra-principal' {
    $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  'wrong-inheritance' {
    $inheritance = if ($env:BRAINSTRIKE_ACL_TEST_KIND -eq 'directory') { 0 } else { 3 }
    $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]$inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  'insufficient-rights' {
    $inheritance = if ($env:BRAINSTRIKE_ACL_TEST_KIND -eq 'directory') { 3 } else { 0 }
    $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.InheritanceFlags]$inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  'unprotected' { $acl.SetAccessRuleProtection($false, $true) }
}
if ($env:BRAINSTRIKE_ACL_TEST_MUTATION) {
  $info.SetAccessControl($acl)
  $acl = $info.GetAccessControl($sections)
}
$rules = @($acl.GetAccessRules($true, $true, $identityType) | ForEach-Object {
  [ordered]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString(); isInherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
})
[ordered]@{ ownerSid = $acl.GetOwner($identityType).Value; currentSid = $sid.Value; protected = $acl.AreAccessRulesProtected; rules = @($rules) } | ConvertTo-Json -Depth 4 -Compress
`;

async function inspect(
  path: string,
  kind: AclKind,
  mutation = ''
): Promise<Record<string, unknown>> {
  const result = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspectCommand],
    {
      env: {
        ...process.env,
        BRAINSTRIKE_ACL_TEST_KIND: kind,
        BRAINSTRIKE_ACL_TEST_MUTATION: mutation,
        BRAINSTRIKE_ACL_TEST_PATH: path,
      },
      windowsHide: true,
    }
  );
  const decoded: unknown = JSON.parse(result.stdout);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Expected real Windows ACL observation');
  }
  return decoded as Record<string, unknown>;
}

async function freshPath(kind: AclKind): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-acl-'));
  roots.push(root);
  const path = join(root, '$(); literal metadata');
  if (kind === 'directory') {
    await mkdir(path);
  } else {
    await writeFile(path, 'metadata');
  }
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

windowsTest(
  'native host metadata preserves privacy and refuses a broadened live file ACL',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-acl-record-'));
    roots.push(root);
    const host = await startHost({ lifetime: 'persistent', root });
    const record = host.record;
    await host.close();
    await publishHostRecord(root, record);
    expect(await readHostRecord(root)).toEqual(record);
    const path = join(root, 'host.json');
    const actual = await inspect(path, 'file');
    expect(actual['protected']).toBe(true);
    expect(actual['rules']).toEqual([
      {
        inheritance: 0,
        isInherited: false,
        propagation: 0,
        rights: 2_032_127,
        sid: actual['currentSid'],
        type: 'Allow',
      },
    ]);
    await inspect(path, 'file', 'extra-principal');
    await expect(readHostRecord(root)).rejects.toThrow();
    await expect(removeOwnHostRecord(root, record)).rejects.toThrow();
    await windowsPrivateAcl(path, 'file', 'set');
    await removeOwnHostRecord(root, record);
    expect(await readHostRecord(root)).toBeNull();
  }
);

for (const kind of ['directory', 'file'] as const) {
  windowsTest(`the PowerShell oracle reapplies the exact private ${kind} ACL twice`, async () => {
    const path = await freshPath(kind);
    for (let round = 0; round < 2; round++) {
      await windowsPrivateAcl(path, kind, 'set');
      await windowsPrivateAcl(path, kind, 'verify');
      const actual = await inspect(path, kind);
      expect(actual).toEqual({
        currentSid: expect.stringMatching(/^S-1-\d+(?:-\d+)+$/),
        ownerSid: actual['currentSid'],
        protected: true,
        rules: [
          {
            inheritance: kind === 'directory' ? 3 : 0,
            isInherited: false,
            propagation: 0,
            rights: 2_032_127,
            sid: actual['currentSid'],
            type: 'Allow',
          },
        ],
      });
    }
  });

  // FileSecurity rejects inheritance flags itself; its malformed result control
  // remains in windows-acl.test.ts. DirectorySecurity permits this real mutation.
  const mutations = ['extra-principal', 'insufficient-rights', 'unprotected'];
  if (kind === 'directory') {
    mutations.push('wrong-inheritance');
  }
  for (const mutation of mutations) {
    windowsTest(`rejects real ${kind} ACL with ${mutation}`, async () => {
      const path = await freshPath(kind);
      await windowsPrivateAcl(path, kind, 'set');
      await inspect(path, kind, mutation);
      await expect(windowsPrivateAcl(path, kind, 'verify')).rejects.toThrow(
        'Host metadata Windows ACL must grant only its current user full control'
      );
    });
  }
}

// BST-2237: host start applies, and every lease check verifies, the directory's
// privacy natively. These mirror the PowerShell directory cases above.
windowsTest('natively reapplies the exact private directory ACL twice', async () => {
  const path = await freshPath('directory');
  for (let round = 0; round < 2; round++) {
    applyPrivateDirectorySync(path);
    verifyWindowsPrivateDirectory(path);
    const actual = await inspect(path, 'directory');
    expect(actual).toEqual({
      currentSid: expect.stringMatching(/^S-1-\d+(?:-\d+)+$/),
      ownerSid: actual['currentSid'],
      protected: true,
      rules: [
        {
          inheritance: 3,
          isInherited: false,
          propagation: 0,
          rights: 2_032_127,
          sid: actual['currentSid'],
          type: 'Allow',
        },
      ],
    });
  }
});

// BST-1941: the old Set-Acl path asked for SeSecurityPrivilege when it reapplied a
// protected DACL, and an elevated token holds that privilege, so a plain run there
// proves nothing. This PowerShell removes the privilege from its own token, which
// processes it starts inherit, shows the token can no longer enable it, the request
// BST-1941's Set-Acl made, then has Node run the native apply and verify twice under
// that token. A .NET SACL read is no control, because on Windows 11 it succeeded
// without the privilege (20 Oct, Sean's box).
const withoutSecurityPrivilegeCommand = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrainstrikeTokenPrivilege {
  [StructLayout(LayoutKind.Sequential)]
  struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)]
  struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returnLength);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  // 0 once applied, or 1300 (ERROR_NOT_ALL_ASSIGNED) when the token does not hold the privilege.
  static int Adjust(string name, uint attributes) {
    IntPtr token;
    // TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) { return Marshal.GetLastWin32Error(); }
    try {
      TokenPrivileges state = new TokenPrivileges();
      state.Count = 1;
      state.Attributes = attributes;
      if (!LookupPrivilegeValue(null, name, out state.Luid)) { return Marshal.GetLastWin32Error(); }
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) { return Marshal.GetLastWin32Error(); }
      return Marshal.GetLastWin32Error();
    } finally { CloseHandle(token); }
  }
  public static int Remove(string name) { return Adjust(name, 4); } // SE_PRIVILEGE_REMOVED
  public static int Enable(string name) { return Adjust(name, 2); } // SE_PRIVILEGE_ENABLED
}
'@
$removal = [BrainstrikeTokenPrivilege]::Remove('SeSecurityPrivilege')
$enable = [BrainstrikeTokenPrivilege]::Enable('SeSecurityPrivilege')
$native = & $env:BRAINSTRIKE_NODE -e $env:BRAINSTRIKE_NATIVE_SCRIPT
[ordered]@{ enable = $enable; native = "$native"; nativeExit = $LASTEXITCODE; removal = $removal } | ConvertTo-Json -Compress
`;
// One line, single quotes only: Windows PowerShell 5.1 does not escape double
// quotes in arguments to native commands.
const nativeReapplyScript =
  "const n = require(process.env.BRAINSTRIKE_SECURE_FS); const p = process.env.BRAINSTRIKE_ACL_TEST_PATH; const s = []; for (let r = 0; r < 2; r++) { n.applyPrivateDirectorySync(p); s.push(n.verifyPrivateDirectorySync(p).status); } process.stdout.write(s.join(' '));";

windowsTest(
  'the native apply and verify never need SeSecurityPrivilege, on any token',
  async () => {
    const path = await freshPath('directory');
    const result = await execute(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', withoutSecurityPrivilegeCommand],
      {
        env: {
          ...process.env,
          BRAINSTRIKE_ACL_TEST_PATH: path,
          BRAINSTRIKE_NATIVE_SCRIPT: nativeReapplyScript,
          BRAINSTRIKE_NODE: process.execPath,
          BRAINSTRIKE_SECURE_FS: createRequire(import.meta.url).resolve(
            '@brainstrike/secure-fs-native'
          ),
        },
        windowsHide: true,
      }
    );
    const observed: unknown = JSON.parse(result.stdout);
    expect(observed).toEqual({
      enable: 1300,
      native: 'private private',
      nativeExit: 0,
      removal: expect.any(Number),
    });
    expect([0, 1300]).toContain(Reflect.get(observed as object, 'removal'));
    const actual = await inspect(path, 'directory');
    expect(actual).toEqual({
      currentSid: expect.stringMatching(/^S-1-\d+(?:-\d+)+$/),
      ownerSid: actual['currentSid'],
      protected: true,
      rules: [
        {
          inheritance: 3,
          isInherited: false,
          propagation: 0,
          rights: 2_032_127,
          sid: actual['currentSid'],
          type: 'Allow',
        },
      ],
    });
  }
);

for (const mutation of [
  'extra-principal',
  'insufficient-rights',
  'unprotected',
  'wrong-inheritance',
]) {
  windowsTest(`natively rejects real directory ACL with ${mutation}`, async () => {
    const path = await freshPath('directory');
    applyPrivateDirectorySync(path);
    const mutated = await inspect(path, 'directory', mutation);
    expect(() => verifyWindowsPrivateDirectory(path)).toThrow(
      'Host metadata Windows ACL must grant only its current user full control'
    );
    expect(await inspect(path, 'directory')).toEqual(mutated);
  });
}

windowsTest('natively rejects a directory another principal owns', () => {
  // TrustedInstaller owns the Windows directory; the verify only reads it.
  const systemRoot = process.env['SystemRoot'];
  expect(systemRoot).toEqual(expect.any(String));
  expect(() => verifyWindowsPrivateDirectory(systemRoot ?? '')).toThrow(
    'Host metadata belongs to another user'
  );
});

const sddlCommand = `
$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# How SDDL spells this user: its SID, or an alias for a well-known account.
$token = [System.Security.AccessControl.RawSecurityDescriptor]::new("O:$($user.Value)").GetSddlForm([System.Security.AccessControl.AccessControlSections]::Owner).Substring(2)
$sddl = [System.IO.DirectoryInfo]::new($env:BRAINSTRIKE_ACL_TEST_PATH).GetAccessControl($sections).GetSecurityDescriptorSddlForm($sections)
[ordered]@{ sddl = $sddl; user = $token } | ConvertTo-Json -Compress
`;

/** The directory's owner and DACL as SDDL, the current user spelled USER. */
async function ownerAndDacl(path: string): Promise<string> {
  const result = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', sddlCommand],
    { env: { ...process.env, BRAINSTRIKE_ACL_TEST_PATH: path }, windowsHide: true }
  );
  const decoded: unknown = JSON.parse(result.stdout);
  const sddl =
    typeof decoded === 'object' && decoded !== null ? Reflect.get(decoded, 'sddl') : null;
  const user =
    typeof decoded === 'object' && decoded !== null ? Reflect.get(decoded, 'user') : null;
  if (typeof sddl !== 'string' || typeof user !== 'string' || user.length === 0) {
    throw new Error('Expected a real Windows SDDL observation');
  }
  return sddl.split(user).join('USER');
}

windowsTest(
  'the native apply writes exactly the owner and DACL the PowerShell set writes',
  async () => {
    const native = await freshPath('directory');
    const powershell = await freshPath('directory');
    applyPrivateDirectorySync(native);
    await windowsPrivateAcl(powershell, 'directory', 'set');
    const expected = await ownerAndDacl(powershell);
    expect(await ownerAndDacl(native)).toBe(expected);
    // One explicit Allow of FILE_ALL_ACCESS to the owner, inherited by containers
    // and objects, in a protected DACL (SDDL flags P, then optionally AR and AI).
    expect(expected).toMatch(/^O:USERD:P(?:AR)?(?:AI)?\(A;OICI;FA;;;USER\)$/);
  }
);
