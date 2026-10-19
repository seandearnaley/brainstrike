'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { afterEach, test } = require('node:test');
const { applyPrivateDirectorySync, verifyPrivateDirectorySync } = require('..');

const windows = process.platform === 'win32';
const WINDOWS_ONLY = windows
  ? false
  : 'Windows DACLs only: on POSIX, host-lease keeps checking the directory mode (0700) and its uid';
const POSIX_ONLY = windows ? 'POSIX only: Windows implements both calls' : false;

let directory;
afterEach(() => {
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
  directory = undefined;
});

// The independent oracle: .NET's view of the directory's owner and DACL, read by
// path, the same reader the host-lease PowerShell verify used. A mutation edits
// the DACL first; `user-owner` makes the fresh directory the user's own, as an
// unelevated token does, whatever this token's default owner for new objects is.
const aclCommand = `
$ErrorActionPreference = 'Stop'
$info = [System.IO.DirectoryInfo]::new($env:BS_PRIVATE_TEST_PATH)
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$identityType = [System.Security.Principal.SecurityIdentifier]
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$both = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$noInheritance = [System.Security.AccessControl.InheritanceFlags]::None
$noPropagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl = $info.GetAccessControl($sections)
switch ($env:BS_PRIVATE_TEST_MUTATION) {
  'user-owner' { $acl.SetOwner($sid) }
  'administrators-owner' { $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) }
  'everyone-read' {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::Read, $allow))
  }
  'users-read' {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $both, $noPropagation, $allow))
  }
  'insufficient-rights' {
    $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Read, $both, $noPropagation, $allow))
  }
  'wrong-inheritance' {
    $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $noInheritance, $noPropagation, $allow))
  }
  'unprotected' { $acl.SetAccessRuleProtection($false, $true) }
}
if ($env:BS_PRIVATE_TEST_MUTATION) {
  $info.SetAccessControl($acl)
  $acl = $info.GetAccessControl($sections)
}
$rules = @($acl.GetAccessRules($true, $true, $identityType) | ForEach-Object {
  [ordered]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
})
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
[ordered]@{ owner = $acl.GetOwner($identityType).Value; current = $sid.Value; protected = $acl.AreAccessRulesProtected; rules = @($rules); elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Depth 4 -Compress
`;
function inspectAcl(path, mutation = '') {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclCommand],
      {
        encoding: 'utf8',
        env: { ...process.env, BS_PRIVATE_TEST_MUTATION: mutation, BS_PRIVATE_TEST_PATH: path },
        windowsHide: true,
      }
    )
  );
}
/** A fresh directory its user owns; the name carries PowerShell metacharacters. */
function freshDirectory() {
  directory = mkdtempSync(join(tmpdir(), 'bs-private-dir-'));
  const path = join(directory, '$(); private root');
  mkdirSync(path);
  inspectAcl(path, 'user-owner');
  return path;
}
function assertPrivate(path) {
  const actual = inspectAcl(path);
  assert.deepEqual(actual, {
    current: actual.current,
    elevated: actual.elevated,
    owner: actual.current,
    protected: true,
    rules: [
      {
        inheritance: 3,
        inherited: false,
        propagation: 0,
        rights: 2_032_127,
        sid: actual.current,
        type: 'Allow',
      },
    ],
  });
}

const usage = {
  message: /PrivateDirectorySync expects one absolute directory path$/,
  name: 'TypeError',
};

test('both calls take exactly one string path', () => {
  for (const call of [applyPrivateDirectorySync, verifyPrivateDirectorySync]) {
    for (const args of [[], [42], [null], ['C:\\one', 'C:\\two']]) {
      assert.throws(() => call(...args), usage);
    }
  }
});

test('both calls refuse with ENOTSUP', { skip: POSIX_ONLY }, () => {
  directory = mkdtempSync(join(tmpdir(), 'bs-private-dir-'));
  for (const call of [applyPrivateDirectorySync, verifyPrivateDirectorySync]) {
    assert.throws(() => call(directory), { code: 'ENOTSUP' });
  }
});

test('both calls refuse a relative, drive-relative or NUL path', { skip: WINDOWS_ONLY }, () => {
  for (const call of [applyPrivateDirectorySync, verifyPrivateDirectorySync]) {
    for (const path of ['', 'relative', 'C:relative', '\\rooted', 'C:\\with\0nul']) {
      assert.throws(() => call(path), usage);
    }
  }
});

test('applies the private DACL, twice, and verifies it', { skip: WINDOWS_ONLY }, () => {
  const path = freshDirectory();
  for (let round = 0; round < 2; round++) {
    applyPrivateDirectorySync(path);
    assertPrivate(path);
    assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'private' });
  }
});

test('verify reports a fresh inheriting directory as not private', { skip: WINDOWS_ONLY }, () => {
  const path = freshDirectory();
  assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'acl-mismatch' });
});

for (const mutation of ['everyone-read', 'users-read', 'wrong-inheritance', 'unprotected']) {
  test(`verify reports ${mutation} without repairing it, and apply repairs it`, {
    skip: WINDOWS_ONLY,
  }, () => {
    const path = freshDirectory();
    applyPrivateDirectorySync(path);
    const mutated = inspectAcl(path, mutation);
    assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'acl-mismatch' });
    assert.deepEqual(inspectAcl(path), mutated);
    applyPrivateDirectorySync(path);
    assertPrivate(path);
  });
}

test('verify reports insufficient-rights, and apply cannot take back WRITE_OWNER', {
  skip: WINDOWS_ONLY,
}, () => {
  // An owner keeps READ_CONTROL and WRITE_DAC implicitly, never WRITE_OWNER;
  // setting the owner needs it, as the PowerShell set's write did.
  const path = freshDirectory();
  applyPrivateDirectorySync(path);
  const mutated = inspectAcl(path, 'insufficient-rights');
  assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'acl-mismatch' });
  assert.throws(() => applyPrivateDirectorySync(path), { code: 'EACCES' });
  assert.deepEqual(inspectAcl(path), mutated);
});

test('verify reports another owner', { skip: WINDOWS_ONLY }, () => {
  // TrustedInstaller owns the Windows directory; this reads it and never writes.
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, 'SystemRoot is set on Windows');
  assert.deepEqual(verifyPrivateDirectorySync(systemRoot), { status: 'foreign-owner' });
});

const elevated = windows && inspectAcl(tmpdir()).elevated === true;
test('apply refuses another owner and changes nothing', {
  skip:
    WINDOWS_ONLY ||
    (elevated
      ? false
      : 'needs an elevated token, the only one that may assign Administrators as owner'),
}, () => {
  const path = freshDirectory();
  const before = inspectAcl(path, 'administrators-owner');
  assert.throws(() => applyPrivateDirectorySync(path), {
    code: 'ERR_PRIVATE_DIRECTORY_VERDICT',
    verdict: 'foreign-owner',
  });
  assert.deepEqual(inspectAcl(path), before);
  assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'foreign-owner' });
});

test('both calls classify a missing path and a regular file', { skip: WINDOWS_ONLY }, () => {
  directory = mkdtempSync(join(tmpdir(), 'bs-private-dir-'));
  const file = join(directory, 'regular');
  writeFileSync(file, 'fake metadata');
  for (const call of [applyPrivateDirectorySync, verifyPrivateDirectorySync]) {
    assert.throws(() => call(join(directory, 'missing')), { code: 'ENOENT' });
    assert.throws(() => call(file), { code: 'ENOTDIR' });
  }
});
