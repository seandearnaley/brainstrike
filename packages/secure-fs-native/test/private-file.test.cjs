'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { afterEach, test } = require('node:test');
const { SecureRoot } = require('..');

let directory;
afterEach(() => {
  if (directory) {
    rmSync(directory, { force: true, recursive: true });
  }
  directory = undefined;
});
function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'bs-private-native-'));
  return new SecureRoot(directory);
}
const aclCommand = `
$ErrorActionPreference = 'Stop'
$info = [System.IO.FileInfo]::new($env:BS_PRIVATE_TEST_PATH)
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$acl = $info.GetAccessControl($sections)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
switch ($env:BS_PRIVATE_TEST_MUTATION) {
 'extra-principal' { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)) }
 'insufficient-rights' { $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)) }
 'unprotected' { $acl.SetAccessRuleProtection($false,$true) }
}
if ($env:BS_PRIVATE_TEST_MUTATION) { $info.SetAccessControl($acl); $acl = $info.GetAccessControl($sections) }
$rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [ordered]@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags; type=$_.AccessControlType.ToString() } })
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
[ordered]@{ owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=$sid.Value; protected=$acl.AreAccessRulesProtected; rules=@($rules); elevated=$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Depth 4 -Compress
`;
function inspectAcl(file, mutation = '') {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclCommand],
      {
        encoding: 'utf8',
        env: { ...process.env, BS_PRIVATE_TEST_MUTATION: mutation, BS_PRIVATE_TEST_PATH: file },
        windowsHide: true,
      }
    )
  );
}
function assertPrivate(file) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    return;
  }
  const actual = inspectAcl(file);
  assert.deepEqual(actual, {
    current: actual.current,
    elevated: false,
    owner: actual.current,
    protected: true,
    rules: [
      {
        inheritance: 0,
        inherited: false,
        propagation: 0,
        rights: 2_032_127,
        sid: actual.current,
        type: 'Allow',
      },
    ],
  });
}

test('creates and replaces a private regular file with no temporary residue', async () => {
  const root = fixture();
  try {
    assert.deepEqual(await root.readPrivateFileAsync('$(); credential.json'), {
      status: 'not-found',
    });
    await root.writePrivateFileAsync('$(); credential.json', Buffer.from('fake first'));
    assertPrivate(join(directory, '$(); credential.json'));
    assert.equal(
      (await root.readPrivateFileAsync('$(); credential.json')).content.toString(),
      'fake first'
    );
    await root.writePrivateFileAsync('$(); credential.json', Buffer.from('fake second'));
    assertPrivate(join(directory, '$(); credential.json'));
    assert.equal(
      (await root.readPrivateFileAsync('$(); credential.json')).content.toString(),
      'fake second'
    );
    assert.deepEqual(readdirSync(directory), ['$(); credential.json']);
  } finally {
    root.close();
  }
});

test('refuses regular files without private permissions and preserves their bytes', async () => {
  const root = fixture();
  const file = join(directory, 'public.json');
  writeFileSync(file, 'fake public', { mode: 0o644 });
  try {
    assert.deepEqual(await root.readPrivateFileAsync('public.json'), { status: 'unreadable' });
    await assert.rejects(
      root.writePrivateFileAsync('public.json', Buffer.from('fake replacement')),
      { code: 'ERR_PRIVATE_FILE_OPERATION' }
    );
    assert.equal(readFileSync(file, 'utf8'), 'fake public');
    assert.deepEqual(readdirSync(directory), ['public.json']);
  } finally {
    root.close();
  }
});

for (const mutation of ['extra-principal', 'insufficient-rights', 'unprotected']) {
  test(`rejects actual Windows ${mutation} ACL without repairing it`, {
    skip: process.platform !== 'win32',
  }, async () => {
    const root = fixture();
    const file = join(directory, 'credential.json');
    try {
      await root.writePrivateFileAsync('credential.json', Buffer.from('fake retained'));
      const before = inspectAcl(file, mutation);
      assert.deepEqual(await root.readPrivateFileAsync('credential.json'), {
        status: 'unreadable',
      });
      await assert.rejects(
        root.writePrivateFileAsync('credential.json', Buffer.from('fake replacement')),
        { code: 'ERR_PRIVATE_FILE_OPERATION' }
      );
      assert.deepEqual(inspectAcl(file), before);
      assert.equal(readFileSync(file, 'utf8'), 'fake retained');
      assert.deepEqual(readdirSync(directory), ['credential.json']);
    } finally {
      root.close();
    }
  });
}

test('refuses leaf symlinks, dangling links, directory leaves and linked parents', async () => {
  const root = fixture();
  try {
    await root.writePrivateFileAsync('target.json', Buffer.from('fake target'));
    symlinkSync('target.json', join(directory, 'link.json'), 'file');
    symlinkSync('absent.json', join(directory, 'dangling.json'), 'file');
    mkdirSync(join(directory, 'sub'));
    symlinkSync(
      join(directory, 'sub'),
      join(directory, 'linked-parent'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    for (const path of ['link.json', 'dangling.json', 'sub', 'linked-parent/file.json']) {
      assert.deepEqual(await root.readPrivateFileAsync(path), { status: 'unreadable' });
      await assert.rejects(root.writePrivateFileAsync(path, Buffer.from('fake rejected')), {
        code: 'ERR_PRIVATE_FILE_OPERATION',
      });
    }
    assert.equal(readFileSync(join(directory, 'target.json'), 'utf8'), 'fake target');
    assert.deepEqual(readdirSync(join(directory, 'sub')), []);
    assert.ok(!readdirSync(directory).some((name) => name.startsWith('.brainstrike-private-')));
  } finally {
    root.close();
  }
});

test('uses the pinned directory after its pathname is replaced', async () => {
  const root = fixture();
  const original = directory;
  const moved = `${original}-moved`;
  try {
    renameSync(original, moved);
    mkdirSync(original);
    await root.writePrivateFileAsync('credential.json', Buffer.from('fake pinned'));
    assert.equal(
      (await root.readPrivateFileAsync('credential.json')).content.toString(),
      'fake pinned'
    );
    assert.equal(readFileSync(join(moved, 'credential.json'), 'utf8'), 'fake pinned');
    assert.deepEqual(readdirSync(original), []);
  } finally {
    root.close();
    rmSync(moved, { force: true, recursive: true });
  }
});

test('drains accepted operations across revocation and rejects later calls', async () => {
  const root = fixture();
  const bytes = Buffer.from('fake snapshot');
  const write = root.writePrivateFileAsync('credential.json', bytes);
  bytes.fill(0);
  root.close();
  await write;
  assert.equal(readFileSync(join(directory, 'credential.json'), 'utf8'), 'fake snapshot');
  await assert.rejects(root.readPrivateFileAsync('credential.json'), {
    code: 'ERR_PRIVATE_FILE_OPERATION',
  });
  await assert.rejects(root.writePrivateFileAsync('other.json', Buffer.from('fake rejected')), {
    code: 'ERR_PRIVATE_FILE_OPERATION',
  });
  assert.deepEqual(readdirSync(directory), ['credential.json']);
});

test('rejects invalid relative paths without touching outside files', async () => {
  const root = fixture();
  try {
    for (const path of [
      '',
      '.',
      '..',
      '../outside.json',
      '/absolute.json',
      'credential\0.json',
      'stream:alternate',
    ]) {
      if (process.platform !== 'win32' && path === 'stream:alternate') {
        continue;
      }
      await assert.rejects(root.readPrivateFileAsync(path), { code: 'ERR_PRIVATE_FILE_OPERATION' });
      await assert.rejects(root.writePrivateFileAsync(path, Buffer.from('fake rejected')), {
        code: 'ERR_PRIVATE_FILE_OPERATION',
      });
    }
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    root.close();
  }
});

test('classifies only a genuinely missing root as ENOENT', () => {
  const root = fixture();
  root.close();
  assert.throws(() => new SecureRoot(join(directory, 'missing')), { code: 'ENOENT' });
  writeFileSync(join(directory, 'regular'), 'fake metadata');
  for (const path of [join(directory, 'regular'), 'relative', `${directory}\0invalid`]) {
    assert.throws(() => new SecureRoot(path), { code: 'ERR_SECURE_FS_ROOT' });
  }
});

test('refuses a POSIX FIFO without waiting for a writer', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fixture();
  try {
    execFileSync('mkfifo', [join(directory, 'fifo')]);
    assert.deepEqual(await root.readPrivateFileAsync('fifo'), { status: 'unreadable' });
    await assert.rejects(root.writePrivateFileAsync('fifo', Buffer.from('fake rejected')), {
      code: 'ERR_PRIVATE_FILE_OPERATION',
    });
  } finally {
    root.close();
  }
});

test('requires exact POSIX 0600 permissions', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fixture();
  const file = join(directory, 'credential.json');
  try {
    await root.writePrivateFileAsync('credential.json', Buffer.from('fake retained'));
    for (const mode of [0o644, 0o400, 0o700]) {
      chmodSync(file, mode);
      assert.deepEqual(await root.readPrivateFileAsync('credential.json'), {
        status: 'unreadable',
      });
      await assert.rejects(
        root.writePrivateFileAsync('credential.json', Buffer.from('fake rejected')),
        {
          code: 'ERR_PRIVATE_FILE_OPERATION',
        }
      );
      assert.equal(readFileSync(file, 'utf8'), 'fake retained');
    }
  } finally {
    root.close();
  }
});

test('failed Windows replacement retains the previous file and joins temp cleanup', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = fixture();
  let child;
  let exited;
  try {
    await root.writePrivateFileAsync('credential.json', Buffer.from('fake retained'));
    child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $file=[IO.File]::Open($env:BS_PRIVATE_TEST_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { $file.Dispose() }",
      ],
      {
        env: { ...process.env, BS_PRIVATE_TEST_PATH: join(directory, 'credential.json') },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    exited = once(child, 'exit');
    await new Promise((resolve, reject) => {
      child.stdout.once('data', (data) =>
        data.toString().trim() === 'ready'
          ? resolve()
          : reject(new Error('Fixture did not acquire lock'))
      );
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Fixture exited before lock: ${code}`)));
    });
    await assert.rejects(
      root.writePrivateFileAsync('credential.json', Buffer.from('fake replacement')),
      {
        code: 'ERR_PRIVATE_FILE_OPERATION',
        message: /^Private file replacement failed \(Windows error \d+\)$/,
      }
    );
    assert.equal(readFileSync(join(directory, 'credential.json'), 'utf8'), 'fake retained');
    assert.deepEqual(readdirSync(directory), ['credential.json']);
  } finally {
    if (child) {
      child.stdin.end('done\n');
      await exited;
    }
    root.close();
  }
});
