import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import type { HostAttachment } from '../src/client.js';
import { launchHost } from '../src/launcher.js';
import { createNodeHostSpawner } from '../src/node-spawner.js';
import type { HostRecord } from '../src/record.js';
import { verifyWindowsPrivateDirectory } from '../src/windows-acl.js';

/*
 * BST-2246 (owner decision A1). An elevated token, for example an OpenSSH admin
 * session without user-owner-run.ps1, defaults new objects' owner to
 * BUILTIN\Administrators. A host started from such a launcher must still create
 * its data root, lock and record owned by the user. A later launch, including
 * one whose token defaults to the user, must reuse that root.
 *
 * The host runs through its real process entry, whose first import sets the
 * process default owner. BRAINSTRIKE_DEFAULT_OWNER_ROOT names a root to keep, so
 * an unwrapped elevated run can create it and a wrapped run can then reuse it.
 */
const windowsTest = test.skipIf(process.platform !== 'win32');
const execute = promisify(execFile);
const spawn = createNodeHostSpawner({
  entrypoint: fileURLToPath(new URL('../src/process-entry.ts', import.meta.url)),
  execArgv: ['--import', 'tsx'],
});
const keptRoot = process.env['BRAINSTRIKE_DEFAULT_OWNER_ROOT'];
const temporary: string[] = [];
const clients: HostAttachment[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

// Owners as a child process reads them. The child's token is a copy of this
// launcher's, so its default owner is the launcher's.
const probeCommand = `
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
$sid = [System.Security.Principal.SecurityIdentifier]
$owners = [ordered]@{}
foreach ($path in @($env:BRAINSTRIKE_OWNER_PATHS -split '\\|' | Where-Object { $_ })) {
  if ([System.IO.Directory]::Exists($path)) {
    $security = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Owner)
  } else {
    $security = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Owner)
  }
  $owners[$path] = $security.GetOwner($sid).Value
}
[ordered]@{ user = $identity.User.Value; defaultOwner = $identity.Owner.Value; elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator); owners = $owners } | ConvertTo-Json -Depth 3 -Compress
`;
interface Probe {
  readonly defaultOwner: string;
  readonly elevated: boolean;
  readonly owners: Readonly<Record<string, string>>;
  readonly user: string;
}
async function probe(paths: readonly string[]): Promise<Probe> {
  const result = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probeCommand],
    { env: { ...process.env, BRAINSTRIKE_OWNER_PATHS: paths.join('|') }, windowsHide: true }
  );
  const decoded: unknown = JSON.parse(result.stdout);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Expected a Windows owner observation');
  }
  return decoded as Probe;
}

async function dataRoot(): Promise<string> {
  if (keptRoot) {
    return keptRoot;
  }
  const parent = await mkdtemp(join(tmpdir(), 'bs-default-owner-'));
  temporary.push(parent);
  return join(parent, 'profile');
}

/**
 * The user owns the root, its lock directory, the live lease's generation file
 * and the host record, and the root passes the lease's privacy verify.
 */
async function assertUserOwnsHost(root: string): Promise<void> {
  const lease = RootLock.inspect(root);
  if (!lease) {
    throw new Error('The launched host holds no root lease');
  }
  const lock = RootLock.dirOf(root);
  const paths = [
    root,
    lock,
    join(lock, `g${String(lease.gen).padStart(12, '0')}`),
    join(root, 'host.json'),
  ];
  const observed = await probe(paths);
  expect(observed.owners).toEqual(Object.fromEntries(paths.map((path) => [path, observed.user])));
  verifyWindowsPrivateDirectory(root);
}

/** A CLI host leaves with its last client; wait until it has released the root. */
async function released(root: string, record: HostRecord): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const owner = RootLock.inspect(root)?.owner;
    if (owner?.released || processStartTime(record.pid) !== record.start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Host ${record.pid} kept the root after its last client left`);
}

windowsTest(
  'the host owns its root, lock and record as the user, and a later launch reuses the root',
  async () => {
    const root = await dataRoot();
    const launcher = await probe([]);
    console.info(
      `launcher token: default owner ${launcher.defaultOwner}, user ${launcher.user}, ` +
        `elevated ${launcher.elevated}; root ${root}`
    );
    const first = await launchHost(root, { lifetime: 'cli', spawn });
    clients.push(first);
    await assertUserOwnsHost(root);

    clients.splice(clients.indexOf(first), 1);
    await first.close();
    await released(root, first.record);
    const second = await launchHost(root, { lifetime: 'cli', spawn });
    clients.push(second);
    expect(second.record.pid).not.toBe(first.record.pid);
    await assertUserOwnsHost(root);
  }
);
