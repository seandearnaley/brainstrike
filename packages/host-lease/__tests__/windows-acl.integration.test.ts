import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { publishHostRecord, readHostRecord, removeOwnHostRecord } from '../src/record-file.js';
import { startHost } from '../src/runtime.js';
import { type AclKind, windowsPrivateAcl } from '../src/windows-acl.js';

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
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
[ordered]@{ ownerSid = $acl.GetOwner($identityType).Value; currentSid = $sid.Value; protected = $acl.AreAccessRulesProtected; rules = @($rules); elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Depth 4 -Compress
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
  // BST-1941: repeating Set-Acl on a protected DACL requested SeSecurityPrivilege.
  windowsTest(`reapplies exact private ${kind} ACL twice without elevation`, async () => {
    const path = await freshPath(kind);
    for (let round = 0; round < 2; round++) {
      await windowsPrivateAcl(path, kind, 'set');
      await windowsPrivateAcl(path, kind, 'verify');
      const actual = await inspect(path, kind);
      expect(actual).toEqual({
        currentSid: expect.stringMatching(/^S-1-\d+(?:-\d+)+$/),
        elevated: false,
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
