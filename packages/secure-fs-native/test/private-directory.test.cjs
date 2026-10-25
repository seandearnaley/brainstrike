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
  : 'Windows DACLs only: on POSIX a private directory is its mode (0700) and its uid';
const POSIX_ONLY = windows ? 'POSIX only: Windows implements both calls' : false;

let directory;
afterEach(() => {
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
  directory = undefined;
});

// The independent oracle: .NET's view of the directory's owner and DACL, read by
// path. A mutation edits
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
/**
 * The privileges enabled in this process's token, as whoami reads them from the
 * copy of that token a child process inherits.
 */
function enabledPrivileges() {
  // System32's whoami by path: Git for Windows puts its POSIX whoami first on a bash PATH.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error('SystemRoot is not set; cannot locate whoami.exe');
  }
  const whoami = join(systemRoot, 'System32', 'whoami.exe');
  const output = execFileSync(whoami, ['/priv', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const enabled = new Set();
  for (const row of output.split(/\r?\n/).filter(Boolean)) {
    const match = /^"([^"]+)","[^"]*","([^"]+)"$/.exec(row);
    if (!(match && ['Enabled', 'Disabled'].includes(match[2]))) {
      throw new Error(`Unrecognized whoami /priv row: ${row}`);
    }
    if (match[2] === 'Enabled') {
      enabled.add(match[1]);
    }
  }
  return enabled;
}
const elevated = windows && inspectAcl(tmpdir()).elevated === true;
// Writing the owner needs WRITE_OWNER. Owning the directory implies only
// READ_CONTROL and WRITE_DAC, and Administrators membership grants nothing a
// DACL naming only the user does not. An enabled SeTakeOwnershipPrivilege grants
// WRITE_OWNER, and so does an enabled SeRestorePrivilege on this
// FILE_FLAG_BACKUP_SEMANTICS open. Most privileges are disabled by default, so
// this reads the token rather than inferring them from elevation.
const writeOwnerPrivileges = windows
  ? [...enabledPrivileges()].filter(
      (name) => name === 'SeTakeOwnershipPrivilege' || name === 'SeRestorePrivilege'
    )
  : [];
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

test('verify reports insufficient-rights, and apply repairs it only with WRITE_OWNER', {
  skip: WINDOWS_ONLY,
}, (t) => {
  t.diagnostic(
    `elevated: ${elevated}; enabled WRITE_OWNER privileges: ${writeOwnerPrivileges.join(', ') || 'none'}`
  );
  const path = freshDirectory();
  applyPrivateDirectorySync(path);
  const mutated = inspectAcl(path, 'insufficient-rights');
  assert.deepEqual(verifyPrivateDirectorySync(path), { status: 'acl-mismatch' });
  assert.deepEqual(inspectAcl(path), mutated);
  if (writeOwnerPrivileges.length > 0) {
    applyPrivateDirectorySync(path);
    assertPrivate(path);
    return;
  }
  assert.throws(
    () => applyPrivateDirectorySync(path),
    { code: 'EACCES' },
    `With no enabled ownership privilege (elevated: ${elevated}), the user lacks WRITE_OWNER`
  );
  assert.deepEqual(inspectAcl(path), mutated);
});

test('verify reports another owner', { skip: WINDOWS_ONLY }, () => {
  // TrustedInstaller owns the Windows directory; this reads it and never writes.
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, 'SystemRoot is set on Windows');
  assert.deepEqual(verifyPrivateDirectorySync(systemRoot), { status: 'foreign-owner' });
});

test('apply refuses another owner and changes nothing', {
  skip:
    WINDOWS_ONLY ||
    (elevated
      ? false
      : 'needs an elevated token, the only one that may assign Administrators as owner'),
}, () => {
  // The owner check runs before any write, so it refuses even a token whose
  // enabled SeRestorePrivilege would let it assign any owner.
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
