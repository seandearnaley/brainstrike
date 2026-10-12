import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { runWithTimeout } from '@brainstrike/effect-kit';
import {
  assertNotSyncedRoot,
  ForeignLockError,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from '@brainstrike/state-store';
import { attachHost, type HostAttachment } from './client.js';
import type { HostRecord } from './record.js';
import { readHostRecord } from './record-file.js';
import type { HostLifetime, HostStartOptions } from './runtime.js';
import { windowsPrivateAcl } from './windows-acl.js';
export type HostSpawner = (options: HostStartOptions, signal: AbortSignal) => Promise<void>;
export interface HostLaunchOptions {
  /** The new host uses canonical JSON-RPC; old-path callers retain their handshake. */
  readonly attach?: (record: HostRecord, timeoutMs: number) => Promise<HostAttachment>;
  readonly attachTimeoutMs?: number;
  readonly lifetime: HostLifetime;
  readonly spawn: HostSpawner;
  readonly startupTimeoutMs?: number;
}
export class LiveHostUnavailableError extends Error {
  constructor(
    readonly pid: number,
    cause: unknown
  ) {
    super(
      `Live host pid ${pid} is unreachable or refused initialize/attach; its owner was not replaced`,
      { cause }
    );
    this.name = 'LiveHostUnavailableError';
  }
}
function isLive(owner: { readonly pid: number; readonly start: string }): boolean {
  return processStartTime(owner.pid) === owner.start;
}
async function liveLease(root: string): Promise<LockOwner | null> {
  const lease = RootLock.inspect(root)?.owner;
  if (!lease || lease.released) {
    return null;
  }
  if (lease.host !== hostname() || lease.root !== (await realpath(root))) {
    throw new ForeignLockError(lease);
  }
  if (!isLive(lease)) {
    return null;
  }
  if (process.platform === 'win32') {
    try {
      await windowsPrivateAcl(root, 'directory', 'verify');
    } catch (cause) {
      throw new LiveHostUnavailableError(lease.pid, cause);
    }
  }
  const directory = await stat(root);
  if (
    process.platform !== 'win32' &&
    ((directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.())
  ) {
    throw new LiveHostUnavailableError(
      lease.pid,
      new Error('Host discovery directory must be private to its user (0700)')
    );
  }
  return lease;
}
function matches(record: HostRecord, owner: LockOwner): boolean {
  return record.pid === owner.pid && record.start === owner.start;
}
async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 25);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** The owner's record once published, or null when that owner released or replaced its lease. */
async function publishedRecord(
  root: string,
  lease: LockOwner,
  timeoutMs: number
): Promise<HostRecord | null> {
  return runWithTimeout(
    async (signal) => {
      for (;;) {
        signal.throwIfAborted();
        const current = await liveLease(root);
        if (!current || current.token !== lease.token) {
          return null;
        }
        const record = await readHostRecord(root);
        if (record && matches(record, current)) {
          return record;
        }
        await pause(signal);
      }
    },
    {
      onTimeout: () =>
        new LiveHostUnavailableError(lease.pid, new Error('Host record publication timed out')),
      timeoutMs,
    }
  );
}
function ownRecord(record: HostRecord | null, lease: LockOwner): HostRecord {
  if (!record) {
    throw new Error(`Host pid ${lease.pid} released or changed its root lease during startup`);
  }
  return record;
}
async function attach(
  record: HostRecord,
  timeoutMs: number,
  attachClient: (record: HostRecord, timeoutMs: number) => Promise<HostAttachment>
): Promise<HostAttachment> {
  try {
    return await attachClient(record, timeoutMs);
  } catch (cause) {
    throw new LiveHostUnavailableError(record.pid, cause);
  }
}

async function existingRecord(root: string, lease: LockOwner | null): Promise<HostRecord | null> {
  try {
    return await readHostRecord(root);
  } catch (cause) {
    if (lease) {
      throw new LiveHostUnavailableError(lease.pid, cause);
    }
    throw cause;
  }
}
/**
 * The live owner's published record, or null when no live owner holds the root.
 * A starting or exiting owner is waited for: attach once it publishes, or start
 * a host after it releases. One deadline bounds the whole wait.
 */
async function liveOwnerRecord(root: string, timeoutMs: number): Promise<HostRecord | null> {
  const waitUntil = Date.now() + timeoutMs;
  for (;;) {
    const lease = await liveLease(root);
    const existing = await existingRecord(root, lease);
    const live = existing !== null && isLive(existing);
    if (live && !lease) {
      throw new LiveHostUnavailableError(
        existing.pid,
        new Error('Host record has no matching root lease')
      );
    }
    if (!lease) {
      return null;
    }
    if (live && matches(existing, lease)) {
      return existing;
    }
    const remaining = waitUntil - Date.now();
    if (remaining <= 0) {
      throw new LiveHostUnavailableError(lease.pid, new Error('Host record publication timed out'));
    }
    const record = await publishedRecord(root, lease, remaining);
    if (record) {
      return record;
    }
  }
}
function startOptionsFor(root: string, lifetime: HostLifetime): HostStartOptions {
  if (lifetime !== 'app') {
    return { lifetime, root };
  }
  const start = processStartTime(process.pid);
  if (start === null) {
    throw new Error('Cannot verify the app parent process identity');
  }
  return { lifetime, parent: { pid: process.pid, start }, root };
}

export async function launchHost(
  root: string,
  options: HostLaunchOptions
): Promise<HostAttachment> {
  if (!isAbsolute(root)) {
    throw new TypeError('Host data root must be absolute');
  }
  assertNotSyncedRoot(root);
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const attachTimeoutMs = options.attachTimeoutMs ?? 1500;
  const attachClient = options.attach ?? attachHost;
  if (![startupTimeoutMs, attachTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Host launch deadlines must be positive finite milliseconds');
  }
  const owned = await liveOwnerRecord(root, startupTimeoutMs);
  if (owned) {
    return attach(owned, attachTimeoutMs, attachClient);
  }
  const startOptions = startOptionsFor(root, options.lifetime);
  try {
    await runWithTimeout((signal) => options.spawn(startOptions, signal), {
      onTimeout: () => new Error('Host startup timed out'),
      timeoutMs: startupTimeoutMs,
    });
  } catch (cause) {
    if (!(cause instanceof RootLockedError)) {
      throw cause;
    }
    // Only a proved acquisition race is attachable. Unrelated spawn errors are
    // returned unchanged; a live owner's endpoint is never replaced or killed.
    const winner = await liveLease(root);
    if (!winner) {
      throw cause;
    }
    return attach(
      ownRecord(await publishedRecord(root, winner, startupTimeoutMs), winner),
      attachTimeoutMs,
      attachClient
    );
  }
  const acquired = await liveLease(root);
  if (!acquired) {
    throw new Error('Host starter returned without a live root lease');
  }
  return attach(
    ownRecord(await publishedRecord(root, acquired, startupTimeoutMs), acquired),
    attachTimeoutMs,
    attachClient
  );
}
