import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { observeFixtureChild, recordFixtureEvent } from './owned-fixture-process.js';

export interface FixtureCloseControl {
  readonly endpoint: string;
  readonly token: string;
}

/** Separate, test-only capability; it never reuses the discovery/authentication token. */
export function createFixtureCloseControl(root: string): FixtureCloseControl {
  const token = randomBytes(32).toString('hex');
  const name = createHash('sha256').update(resolve(root)).update(token).digest('hex');
  return { endpoint: `\\\\.\\pipe\\bs-m3-fixture-close-${name}`, token };
}

export function fixtureControlEnvironment(control: FixtureCloseControl): NodeJS.ProcessEnv {
  return { BRAINSTRIKE_M3_FIXTURE_CLOSE_CONTROL: JSON.stringify(control) };
}

/** Resolve the disposable target before deletion; retain failed/live leases. */
export async function removeFixtureRoot(root: string): Promise<void> {
  const target = await realpath(root);
  const location = relative(await realpath(tmpdir()), target);
  if (
    !location ||
    location === '..' ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location) ||
    !basename(target).startsWith('bs-m3-')
  ) {
    throw new Error('Refusing removal outside the allocated fixture temp directory');
  }
  const owner = RootLock.inspect(target)?.owner;
  // A released generation can belong to the still-live Vitest coordinator
  // after StateStore reopen/close; the released marker owns that fact.
  if (owner && !owner.released) {
    throw new Error('Retaining fixture root with an unreleased owner');
  }
  await rm(target, { force: true, recursive: true });
  recordFixtureEvent('owned-fixture-root-removed', { root: target });
}

export async function closeFixtureHost(
  owner: HostRecord,
  control: FixtureCloseControl
): Promise<void> {
  if (processStartTime(owner.pid) !== owner.start) {
    // Ordinary CLI lifetime can finish between the caller's liveness check
    // and this one. The recorded identity is already gone; send no control.
    recordFixtureEvent('cooperative-host-already-gone', { pid: owner.pid, start: owner.start });
    return;
  }
  recordFixtureEvent('cooperative-host-close-request', { pid: owner.pid, start: owner.start });
  await new Promise<void>((resolveClose, reject) => {
    const socket = createConnection(control.endpoint);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.end(
        `${JSON.stringify({ event: 'close', pid: owner.pid, start: owner.start, token: control.token })}\n`
      );
    });
    socket.on('data', (value: string) => {
      response += value;
    });
    socket.once('close', () => {
      if (response !== 'accepted\n') {
        reject(new Error('Fixture owner did not accept cooperative close'));
        return;
      }
      recordFixtureEvent('cooperative-host-close-accepted', { pid: owner.pid, start: owner.start });
      resolveClose();
    });
  }).catch((cause: unknown) => {
    // Also allow natural exit while connecting. Keep a live owner's protocol
    // failure visible, and never direct control at a reused PID.
    if (processStartTime(owner.pid) === owner.start) {
      throw cause;
    }
    recordFixtureEvent('cooperative-host-exited-during-close', {
      pid: owner.pid,
      start: owner.start,
    });
  });
  // Acknowledgement means the close request was accepted. Join the actual
  // process handle before the caller checks the unchanged released marker.
  const powershell = process.env['M3_WINDOWS_POWERSHELL'] ?? 'pwsh.exe';
  const script = fileURLToPath(new URL('./windows-owner-join.ps1', import.meta.url));
  const child = spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-File',
      script,
      '-OwnedPid',
      String(owner.pid),
      '-ExpectedStart',
      owner.start,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const observed = observeFixtureChild(child, (pid) => {
    const start = processStartTime(pid);
    if (!start) {
      throw new Error('Cannot identify fixture join process');
    }
    return { executable: powershell, pid, start };
  });
  const result = await observed.done;
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Fixture owner join failed: ${observed.output.stderr()}`);
  }
  if (processStartTime(owner.pid) === owner.start) {
    throw new Error('Fixture owner still alive after process join');
  }
  recordFixtureEvent('cooperative-host-physically-joined', { pid: owner.pid, start: owner.start });
}
