'use strict';

// Runs in its own process (node --test isolates files): it changes this
// process token's default owner for every test after it.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { setDefaultOwnerToCurrentUserSync } = require('..');

const windows = process.platform === 'win32';
let directory;
after(() => {
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
});

// The token as a child process sees it: a child gets a copy of this process's
// primary token, so its default owner shows what this process now creates
// with, and the paths' owners show what it did create with.
const probeCommand = `
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
$sid = [System.Security.Principal.SecurityIdentifier]
$owners = [ordered]@{}
foreach ($path in @($env:BS_OWNER_PATHS -split '\\|' | Where-Object { $_ })) {
  if ([System.IO.Directory]::Exists($path)) {
    $security = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Owner)
  } else {
    $security = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Owner)
  }
  $owners[$path] = $security.GetOwner($sid).Value
}
[ordered]@{ user = $identity.User.Value; defaultOwner = $identity.Owner.Value; elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator); owners = $owners } | ConvertTo-Json -Depth 3 -Compress
`;
function probe(paths) {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probeCommand],
      {
        encoding: 'utf8',
        env: { ...process.env, BS_OWNER_PATHS: paths.join('|') },
        windowsHide: true,
      }
    )
  );
}

test('takes no arguments', () => {
  assert.throws(() => setDefaultOwnerToCurrentUserSync('Administrators'), {
    message: /^setDefaultOwnerToCurrentUserSync takes no arguments$/u,
    name: 'TypeError',
  });
});

test('does nothing on POSIX', {
  skip: windows ? 'Windows sets the token default owner' : false,
}, () => {
  assert.equal(setDefaultOwnerToCurrentUserSync(), undefined);
});

test('the user owns what this process, and a child it starts, create afterwards', {
  skip: windows ? false : 'POSIX has no token default owner',
}, (t) => {
  const before = probe([]);
  t.diagnostic(
    `before: default owner ${before.defaultOwner}, user ${before.user}, elevated ${before.elevated}`
  );
  assert.equal(setDefaultOwnerToCurrentUserSync(), undefined);
  directory = mkdtempSync(join(tmpdir(), 'bs-default-owner-'));
  const nested = join(directory, 'created-after');
  mkdirSync(nested);
  const file = join(nested, 'record.json');
  writeFileSync(file, 'fake record');
  const afterwards = probe([directory, nested, file]);
  assert.equal(afterwards.user, before.user);
  assert.equal(afterwards.defaultOwner, afterwards.user);
  assert.deepEqual(afterwards.owners, {
    [directory]: afterwards.user,
    [nested]: afterwards.user,
    [file]: afterwards.user,
  });
  // Idempotent: a second entry in the same process changes nothing.
  assert.equal(setDefaultOwnerToCurrentUserSync(), undefined);
});
