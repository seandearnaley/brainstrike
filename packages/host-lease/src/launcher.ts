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
import { HOST_LEASE_CLOSING, HOST_LEASE_CONNECTION_CLOSED } from './refusal.js';
import type { HostLifetime, HostStartOptions } from './runtime.js';
import { RootContentionError } from './startup-failure.js';
import { windowsPrivateAcl } from './windows-acl.js';
/**
 * A host a starter started, still owned by the launch that asked for it
 * (BST-2167). The launch settles it exactly once: `release` once it attached,
 * `retire` when it gives up, so a launch never abandons a host it started.
 */
export interface StartedHost {
  /** The launch attached: the host keeps the lifetime it was started with. */
  release(): Promise<void>;
  /** The launch gave up on it: cancel the host and join its exit. */
  retire(): Promise<void>;
}
export type HostSpawner = (options: HostStartOptions, signal: AbortSignal) => Promise<StartedHost>;
export interface HostLaunchOptions {
  /** The new host uses canonical JSON-RPC; old-path callers retain their handshake. */
  readonly attach?: (record: HostRecord, timeoutMs: number) => Promise<HostAttachment>;
  /**
   * An attach's budget, 1.5 s by default. The host this launch started gets
   * all of it once its starter reports ready (BST-2176); any other owner's
   * attach is also clipped to what the startup deadline has left.
   */
  readonly attachTimeoutMs?: number;
  readonly lifetime: HostLifetime;
  readonly spawn: HostSpawner;
  /**
   * The acquisition deadline, 30 s by default: waiting for a starting or
   * leaving owner, attaching to one, and starting a host until it is ready.
   */
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
/**
 * Whether the owner `record` names stops holding the root before `deadline`:
 * its lease released, expired with its process, or taken by another owner.
 */
async function ownerLeaves(root: string, record: HostRecord, deadline: number): Promise<boolean> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  for (;;) {
    const lease = await liveLease(root);
    if (!(lease && matches(record, lease))) {
      return true;
    }
    try {
      await pause(signal);
    } catch {
      return false;
    }
  }
}
/**
 * Codes of an owner whose sockets are closing or already gone: the transport's,
 * and the host lease's typed closing and lost-connection refusals. Classified
 * by code, never by message (BST-2158).
 */
const LEAVING_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'EPIPE',
  HOST_LEASE_CLOSING,
  HOST_LEASE_CONNECTION_CLOSED,
]);
/** The agent host's typed closing and connection-loss failures, matched by code. */
const LEAVING_FAILURE_CODES = new Set([
  'host.closing',
  'host.connection-closed',
  'host.connection-lost',
]);
/**
 * Whether an attach failure shows the owner may be leaving: it refused as
 * closing, or its transport was lost. An authentication, version, protocol or
 * record failure, or a handshake timeout, shows nothing of the kind: it stays
 * terminal, and never starts another owner (docs/agents/host-lease.md).
 */
function ownerMayBeLeaving(cause: unknown, depth = 0): boolean {
  if (depth > 4 || typeof cause !== 'object' || cause === null) {
    return false;
  }
  if (cause instanceof AggregateError) {
    return cause.errors.some((inner) => ownerMayBeLeaving(inner, depth + 1));
  }
  const code = Reflect.get(cause, 'code');
  const failure = Reflect.get(cause, 'failure');
  const failureCode =
    typeof failure === 'object' && failure !== null ? Reflect.get(failure, 'code') : undefined;
  if (
    (typeof code === 'string' && LEAVING_CODES.has(code)) ||
    (typeof failureCode === 'string' && LEAVING_FAILURE_CODES.has(failureCode))
  ) {
    return true;
  }
  return ownerMayBeLeaving(Reflect.get(cause, 'cause'), depth + 1);
}
/**
 * Attach to an owner. BST-2142: an owner that refuses because it is closing,
 * or whose transport is lost, is leaving; wait for it to give up the root,
 * then acquire again (null). An owner that keeps the root to the deadline is
 * live and unreachable, and any other attach failure is terminal: refused,
 * with the attach failure as the cause.
 */
async function attachOrAwaitExit(
  root: string,
  record: HostRecord,
  deadline: number,
  timeoutMs: number,
  attachClient: (record: HostRecord, timeoutMs: number) => Promise<HostAttachment>
): Promise<HostAttachment | null> {
  try {
    // The attach never outlasts its phase's deadline: the launch's, or the
    // attach budget of a host this launch started (BST-2176).
    return await attachClient(record, Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
  } catch (cause) {
    if (ownerMayBeLeaving(cause) && (await ownerLeaves(root, record, deadline))) {
      return null;
    }
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

/** One launch: its root, options and the deadline its acquisition shares. */
interface Launch {
  readonly attachClient: (record: HostRecord, timeoutMs: number) => Promise<HostAttachment>;
  readonly attachTimeoutMs: number;
  readonly deadline: number;
  readonly options: HostLaunchOptions;
  readonly root: string;
}
/** An attachment, or AGAIN: the owner left, so acquisition starts over. */
const AGAIN = Symbol('acquire again');
type Step = HostAttachment | typeof AGAIN;

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}
async function attachOwner(launch: Launch, record: HostRecord, deadline: number): Promise<Step> {
  return (
    (await attachOrAwaitExit(
      launch.root,
      record,
      deadline,
      launch.attachTimeoutMs,
      launch.attachClient
    )) ?? AGAIN
  );
}
/** The race this starter lost: attach to its winner, or start over once that winner left. */
async function attachWinner(launch: Launch, cause: unknown): Promise<Step> {
  if (cause instanceof RootContentionError) {
    return AGAIN;
  }
  if (!(cause instanceof RootLockedError)) {
    throw cause;
  }
  // Only a proved acquisition race is attachable. Unrelated spawn errors are
  // returned unchanged; a live owner's endpoint is never replaced or killed.
  const winner = await liveLease(launch.root);
  if (!winner) {
    return AGAIN;
  }
  const record = await publishedRecord(launch.root, winner, remaining(launch.deadline));
  return record ? attachOwner(launch, record, launch.deadline) : AGAIN;
}
/** Retire a host the launch gave up on; a failed retirement joins the launch's own failure. */
async function retireAfter(started: StartedHost, cause: unknown): Promise<never> {
  try {
    await started.retire();
  } catch (retireCause) {
    throw new AggregateError(
      [cause, retireCause],
      'Host launch failed and the host it started did not retire',
      { cause }
    );
  }
  throw cause;
}
/**
 * Start a host under the launch's one deadline. At the deadline the starter's
 * signal aborts and the launch waits for that starter to settle, so its
 * cancellation, and the exit of any child it started, is joined before the
 * launch rejects. A host reported started after the deadline is retired.
 */
async function startWithin(launch: Launch, options: HostStartOptions): Promise<StartedHost> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error('Host startup timed out')),
    remaining(launch.deadline)
  );
  let started: StartedHost;
  try {
    started = await launch.options.spawn(options, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
  if (deadline.signal.aborted) {
    return retireAfter(started, deadline.signal.reason);
  }
  return started;
}
/**
 * BST-2176: attach to the host this launch started under `deadline`, its own
 * attach budget, never what the startup deadline has left. The record read,
 * the handshake and any wait for that host to leave all share it.
 */
async function attachStarted(launch: Launch, deadline: number): Promise<Step> {
  const acquired = await liveLease(launch.root);
  if (!acquired) {
    throw new Error('Host starter returned without a live root lease');
  }
  // The host this launch started may itself be leaving by now (an idle CLI
  // host with no client yet): the same exit-aware attach as any other owner,
  // and one that released before publishing sends the launch back to the start.
  const record = await publishedRecord(launch.root, acquired, remaining(deadline));
  return record ? attachOwner(launch, record, deadline) : AGAIN;
}
/**
 * BST-2167: the launch owns the host it started until it settles it. An
 * attachment releases that host to its lifetime; giving up, or a host that
 * left on its own, retires it, so no started host outlives a failed launch.
 */
async function startAndAttach(launch: Launch): Promise<Step> {
  const startOptions = startOptionsFor(launch.root, launch.options.lifetime);
  let started: StartedHost;
  try {
    started = await startWithin(launch, startOptions);
  } catch (cause) {
    return attachWinner(launch, cause);
  }
  const attachDeadline = Date.now() + launch.attachTimeoutMs;
  let step: Step;
  try {
    step = await attachStarted(launch, attachDeadline);
  } catch (cause) {
    return retireAfter(started, cause);
  }
  if (step === AGAIN) {
    await started.retire();
    return AGAIN;
  }
  try {
    await started.release();
  } catch (cause) {
    await step.close();
    throw cause;
  }
  return step;
}

export async function launchHost(
  root: string,
  options: HostLaunchOptions
): Promise<HostAttachment> {
  if (!isAbsolute(root)) {
    throw new TypeError('Host data root must be absolute');
  }
  assertNotSyncedRoot(root);
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const attachTimeoutMs = options.attachTimeoutMs ?? 1500;
  if (![startupTimeoutMs, attachTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Host launch deadlines must be positive finite milliseconds');
  }
  // BST-2142: one deadline bounds acquisition. An owner that leaves while it
  // is waited for, attached to or raced against sends the launcher back to the
  // start, never to an error naming an owner that is gone. BST-2176: the host
  // this launch started then attaches under its own attachTimeoutMs, so a
  // self-started launch settles within startupTimeoutMs + attachTimeoutMs,
  // plus joining the exit of a host it retires.
  const launch: Launch = {
    attachClient: options.attach ?? attachHost,
    attachTimeoutMs,
    deadline: Date.now() + startupTimeoutMs,
    options,
    root,
  };
  for (;;) {
    if (Date.now() >= launch.deadline) {
      throw new Error('Host startup timed out');
    }
    const owned = await liveOwnerRecord(root, remaining(launch.deadline));
    const step = owned
      ? await attachOwner(launch, owned, launch.deadline)
      : await startAndAttach(launch);
    if (step !== AGAIN) {
      return step;
    }
  }
}
