import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestContext, test } from 'vitest';
import {
  ForeignLockError,
  type LockOwner,
  type LockProcessIdentity,
  type LockRetirementReceipt,
  RootLock,
  RootLockedError,
} from '../src/lock.js';
import { legacyRootLockSource } from './fixtures/legacy-root-lock.mjs';

interface Reply {
  readonly event: string;
  readonly gen?: number;
  readonly id?: number;
  readonly identity?: LockProcessIdentity;
  readonly name?: string;
  readonly owner?: LockOwner;
  readonly receipt?: LockRetirementReceipt;
  readonly released?: boolean;
}
interface Request {
  readonly authority?: LockProcessIdentity;
  readonly firstLink?: string;
  readonly op: string;
  readonly proof?: string;
  readonly receipt?: LockRetirementReceipt;
}
interface Actor {
  readonly child: ChildProcess;
  readonly exit: () => Promise<void>;
  readonly identity: LockProcessIdentity;
  readonly replies: Reply[];
  readonly request: (request: Request) => { id: number; done: Promise<Reply> };
  readonly wait: (event: string, id: number) => Promise<Reply>;
}
interface EncodedOwner {
  host: string;
  pid:
    | { version: number; writer: number; retirementAuthority: { pid: number; start: string } }
    | number;
  released?: boolean;
  root: string;
  start: string;
  token: string;
}

function fileAppears(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), check);
    const cleanup = (): void => {
      watcher.close();
      signal.removeEventListener('abort', aborted);
    };
    const aborted = (): void => {
      cleanup();
      reject(signal.reason);
    };
    function check(): void {
      if (existsSync(path)) {
        cleanup();
        resolve();
      }
    }
    watcher.once('error', (error) => {
      cleanup();
      reject(error);
    });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
    } else {
      check();
    }
  });
}

async function fixture(t: TestContext): Promise<{
  base: string;
  root: string;
  actor: (legacy?: boolean) => Promise<Actor>;
}> {
  const base = mkdtempSync(join(tmpdir(), 'bs-root-retirement-'));
  const root = join(base, 'root');
  mkdirSync(root);
  const legacy = join(base, 'legacy-root-lock.mjs');
  writeFileSync(legacy, legacyRootLockSource);
  copyFileSync(
    fileURLToPath(new URL('../src/fs-retry.mjs', import.meta.url)),
    join(base, 'fs-retry.mjs')
  );
  const actors: Actor[] = [];
  t.onTestFinished(async () => {
    // Unblock a first-link observer even when its test failed. Physically join
    // every owned actor before deleting this disposable fixture Root.
    writeFileSync(join(base, 'first-link.continue'), 'continue');
    await Promise.all(actors.map((actor) => actor.exit()));
    rmSync(base, { recursive: true });
  });
  return {
    actor: async (old = false) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./fixtures/root-retirement-owner.ts', import.meta.url)),
          root,
          ...(old ? [legacy] : []),
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }
      );
      const replies: Reply[] = [];
      let failure: Error | undefined;
      let stderr = '';
      let closed = false;
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('message', (message: Reply) => {
        replies.push(message);
        child.emit('fixture-reply');
      });
      child.on('error', (error) => {
        failure = error;
        child.emit('fixture-reply');
      });
      const joined = new Promise<void>((resolve) =>
        child.once('close', () => {
          closed = true;
          resolve();
        })
      );
      const wait = (event: string, id?: number): Promise<Reply> =>
        new Promise((resolve, reject) => {
          const cleanup = (): void => {
            child.off('fixture-reply', check);
            child.off('close', check);
            t.signal.removeEventListener('abort', aborted);
          };
          const aborted = (): void => {
            cleanup();
            reject(t.signal.reason);
          };
          const check = (): void => {
            const message = replies.find(
              (reply) =>
                (id === undefined || reply.id === id) &&
                (reply.event === event ||
                  (event === 'terminal' && ['acquired', 'ok', 'failed'].includes(reply.event)))
            );
            if (message) {
              cleanup();
              resolve(message);
            } else if (failure || closed) {
              cleanup();
              reject(failure ?? new Error(`Fixture closed: ${stderr}`));
            }
          };
          child.on('fixture-reply', check);
          child.on('close', check);
          t.signal.addEventListener('abort', aborted, { once: true });
          if (t.signal.aborted) {
            aborted();
          } else {
            check();
          }
        });
      let next = 0;
      const actor: Actor = {
        child,
        exit: async () => {
          if (!closed && child.connected) {
            child.send({ id: ++next, op: 'exit' }, (error) => {
              if (error) {
                child.disconnect();
              }
            });
          }
          await joined;
          expect(failure).toBeUndefined();
          expect(child.exitCode, stderr).toBe(0);
          expect(child.signalCode).toBeNull();
        },
        identity: { pid: 0, start: '' },
        replies,
        request: (request) => {
          const id = ++next;
          const done = wait('terminal', id);
          child.send({ ...request, id }, (error) => {
            if (error) {
              failure = error;
              child.emit('fixture-reply');
            }
          });
          return { done, id };
        },
        wait,
      };
      actors.push(actor);
      const ready = await wait('ready');
      expect(ready.identity?.pid).toBe(child.pid);
      Object.assign(actor, { identity: ready.identity });
      return actor;
    },
    base,
    root,
  };
}

const generation = (root: string, gen: number): string =>
  join(RootLock.dirOf(root), `g${String(gen).padStart(12, '0')}`);
async function armed(t: TestContext): Promise<{
  base: string;
  root: string;
  authority: Actor;
  writer: Actor;
  receipt: LockRetirementReceipt;
  actor: (legacy?: boolean) => Promise<Actor>;
}> {
  const f = await fixture(t);
  const authority = await f.actor();
  const writer = await f.actor();
  const acquired = await writer.request({ authority: authority.identity, op: 'acquire' }).done;
  expect(acquired.event).toBe('acquired');
  expect(acquired.receipt).toBeDefined();
  return { ...f, authority, receipt: acquired.receipt as LockRetirementReceipt, writer };
}

test('first fsynced armed link is visible to actual old and new readers before acquire returns', async (t) => {
  const f = await fixture(t);
  const authority = await f.actor();
  const writer = await f.actor();
  const firstLink = join(f.base, 'first-link');
  const linked = fileAppears(`${firstLink}.linked`, t.signal);
  const pending = writer.request({ authority: authority.identity, firstLink, op: 'acquire' });
  await linked;
  const path = generation(f.root, 0);
  const before = readFileSync(path);
  expect(JSON.parse(before.toString())).toEqual({
    host: RootLock.inspect(f.root)?.owner.host,
    pid: { retirementAuthority: authority.identity, version: 1, writer: writer.identity.pid },
    root: realpathSync(f.root),
    start: writer.identity.start,
    token: RootLock.inspect(f.root)?.owner.token,
  });
  const old = await f.actor(true);
  expect(await old.request({ op: 'acquire' }).done).toMatchObject({
    event: 'failed',
    name: 'Error',
  });
  await expect(RootLock.acquire(f.root)).rejects.toBeInstanceOf(RootLockedError);
  expect(readFileSync(path)).toEqual(before);
  writeFileSync(`${firstLink}.continue`, 'continue');
  expect((await pending.done).event).toBe('acquired');
});

test('dead writer cannot admit old/new contenders; missing and rejected proofs preserve its generation', async (t) => {
  const f = await armed(t);
  await f.writer.exit();
  const path = generation(f.root, f.receipt.gen);
  const before = readFileSync(path);
  const old = await f.actor(true);
  expect((await old.request({ op: 'acquire' }).done).event).toBe('failed');
  await expect(RootLock.acquire(f.root)).rejects.toBeInstanceOf(RootLockedError);
  for (const proof of ['missing', 'reject', 'false']) {
    expect(
      (await f.authority.request({ op: 'retire', proof, receipt: f.receipt }).done).event
    ).toBe('failed');
    expect(readFileSync(path)).toEqual(before);
  }
});

test('only designated successful proof releases the exact generation for old then new successors', async (t) => {
  const f = await armed(t);
  await f.writer.exit();
  await expect(RootLock.retire(f.receipt, async () => undefined)).rejects.toThrow();
  const stale = { ...f.receipt, owner: { ...f.receipt.owner, token: 'stale-receipt' } };
  const rejected = f.authority.request({ op: 'retire', proof: 'ok', receipt: stale });
  expect((await rejected.done).event).toBe('failed');
  expect(
    f.authority.replies.some((reply) => reply.id === rejected.id && reply.event === 'proof-started')
  ).toBe(false);
  expect(
    (await f.authority.request({ op: 'retire', proof: 'ok', receipt: f.receipt }).done).event
  ).toBe('ok');
  const { retirementAuthority: _authority, ...legacyOwner } = f.receipt.owner;
  expect(JSON.parse(readFileSync(generation(f.root, f.receipt.gen), 'utf8'))).toEqual({
    ...legacyOwner,
    released: true,
  });
  const old = await f.actor(true);
  expect(await old.request({ op: 'acquire' }).done).toMatchObject({
    event: 'acquired',
    gen: f.receipt.gen + 1,
  });
  expect((await old.request({ op: 'release' }).done).event).toBe('ok');
  const current = await f.actor();
  expect(await current.request({ op: 'acquire' }).done).toMatchObject({
    event: 'acquired',
    gen: f.receipt.gen + 2,
  });
  expect((await current.request({ op: 'release' }).done).event).toBe('ok');
  expect(
    (await f.authority.request({ op: 'retire', proof: 'ok', receipt: f.receipt }).done).event
  ).toBe('failed');
});

test('synchronous armed release refuses and acknowledgement requires exact newest legacy released identity', async (t) => {
  const f = await armed(t);
  expect(await f.writer.request({ op: 'release' }).done).toMatchObject({
    event: 'failed',
    released: false,
  });
  expect(await f.writer.request({ op: 'acknowledge' }).done).toMatchObject({
    event: 'failed',
    released: false,
  });
  expect(
    (await f.authority.request({ op: 'retire', proof: 'ok', receipt: f.receipt }).done).event
  ).toBe('ok');
  expect(await f.writer.request({ op: 'acknowledge' }).done).toMatchObject({
    event: 'ok',
    released: true,
  });
  expect((await f.writer.request({ op: 'release' }).done).event).toBe('ok');
});

test('a successor appearing before acknowledgement cannot release the old local object', async (t) => {
  const f = await armed(t);
  expect(
    (await f.authority.request({ op: 'retire', proof: 'ok', receipt: f.receipt }).done).event
  ).toBe('ok');
  const successor = await RootLock.acquire(f.root);
  expect(await f.writer.request({ op: 'acknowledge' }).done).toMatchObject({
    event: 'failed',
    released: false,
  });
  successor.release();
});

test('authority loss and foreign/copied armed Roots never become retirement evidence', async (t) => {
  const f = await armed(t);
  const copy = join(f.base, 'copied-root');
  cpSync(f.root, copy, { recursive: true });
  let asked = false;
  await expect(
    RootLock.acquire(copy, {
      onForeignLock: () => {
        asked = true;
        return true;
      },
    })
  ).rejects.toBeInstanceOf(ForeignLockError);
  expect(asked).toBe(false);
  for (const owner of [
    { ...f.receipt.owner, root: realpathSync(copy) },
    { ...f.receipt.owner, host: 'foreign-host' },
  ]) {
    expect(
      (
        await f.authority.request({ op: 'retire', proof: 'ok', receipt: { ...f.receipt, owner } })
          .done
      ).event
    ).toBe('failed');
  }
  await f.authority.exit();
  await f.writer.exit();
  await expect(RootLock.acquire(f.root)).rejects.toBeInstanceOf(RootLockedError);
  await expect(RootLock.retire(f.receipt, async () => undefined)).rejects.toThrow();
  const fresh = join(f.base, 'fresh');
  mkdirSync(fresh);
  await expect(
    RootLock.acquire(fresh, { retirementAuthority: f.authority.identity })
  ).rejects.toThrow();
  expect(RootLock.inspect(fresh)).toBeNull();
});

test.for([
  'writer',
  'writer-start',
  'token',
  'host',
  'root',
  'authority',
  'authority-start',
  'generation',
  'removed',
  'released',
] as const)('awaited proof refuses changed %s without overwriting it', async (field, t) => {
  const f = await armed(t);
  const path = generation(f.root, f.receipt.gen);
  const pending = f.authority.request({ op: 'retire', proof: 'pause', receipt: f.receipt });
  await f.authority.wait('proof-started', pending.id);
  await expect(RootLock.acquire(f.root)).rejects.toBeInstanceOf(RootLockedError);
  const owner = JSON.parse(readFileSync(path, 'utf8')) as EncodedOwner;
  expect(typeof owner.pid).toBe('object');
  if (typeof owner.pid === 'number') {
    throw new Error('Expected armed fixture');
  }
  let changed = path;
  switch (field) {
    case 'writer':
      owner.pid.writer += 1;
      break;
    case 'writer-start':
      owner.start = 'changed';
      break;
    case 'token':
      owner.token = 'changed';
      break;
    case 'host':
      owner.host = 'changed';
      break;
    case 'root':
      owner.root = `${f.root}-changed`;
      break;
    case 'authority':
      owner.pid.retirementAuthority.pid = f.writer.identity.pid;
      break;
    case 'authority-start':
      owner.pid.retirementAuthority.start = 'changed';
      break;
    case 'generation':
      changed = generation(f.root, f.receipt.gen + 1);
      break;
    case 'removed':
      unlinkSync(path);
      break;
    case 'released':
      owner.pid = f.writer.identity.pid;
      owner.released = true;
      break;
  }
  if (field !== 'removed') {
    writeFileSync(changed, JSON.stringify(owner));
  }
  const before = field === 'removed' ? undefined : readFileSync(changed);
  expect((await f.authority.request({ op: 'resume' }).done).event).toBe('ok');
  expect((await pending.done).event).toBe('failed');
  if (before) {
    expect(readFileSync(changed)).toEqual(before);
  } else {
    expect(existsSync(path)).toBe(false);
  }
});
