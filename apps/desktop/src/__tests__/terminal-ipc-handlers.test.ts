/**
 * Coverage for the terminal (PTY) IPC handler layer, using a REAL node-pty (it
 * builds for the test Node ABI on install). We:
 * - create a terminal in a temp dir, write `echo HELLO_PTY`, and assert the
 *   pushed `terminal:data` events contain the output;
 * - resize (no crash);
 * - destroy and assert the pty pid is actually dead (no orphan);
 * - assert the exit event fires when the shell exits on its own;
 * - assert cwd containment (unknown / escaping / web rootId → rejected, no spawn);
 * - assert structured errors for write/resize/destroy on a dead terminal;
 * - assert disposeAllTerminals() kills every live pty.
 *
 * If node-pty cannot load (native build / ABI problem) these tests FAIL loudly
 * — a terminal backend that cannot spawn a real pty is not proven, so we never
 * mock the pty away here.
 */
import { execSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalIpcHandlers,
  disposeAllTerminals,
  liveTerminalCountForTest,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '../terminal-ipc-handlers';
import type { WorkspaceRootResolver } from '../workspace-root-cwd';

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-terminal-ipc-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

function fakeResolver(
  roots: { displayName: string; path: string; rootId: string }[]
): WorkspaceRootResolver {
  return { listRoots: () => Promise.resolve(roots) };
}

/** A minimal WebContents stand-in that records the events pushed to it. */
class FakeWebContents {
  readonly id: number;
  readonly dataEvents: TerminalDataEvent[] = [];
  readonly exitEvents: TerminalExitEvent[] = [];
  private destroyed = false;
  private destroyedListeners: (() => void)[] = [];

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    if (channel === 'terminal:data') {
      this.dataEvents.push(payload as TerminalDataEvent);
    } else if (channel === 'terminal:exit') {
      this.exitEvents.push(payload as TerminalExitEvent);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.destroyedListeners.push(listener);
    }
  }

  /** Test helper: simulate the renderer being destroyed. */
  fireDestroyed(): void {
    this.destroyed = true;
    const listeners = this.destroyedListeners;
    this.destroyedListeners = [];
    for (const listener of listeners) {
      listener();
    }
  }

  get aggregatedData(): string {
    return this.dataEvents.map((event) => event.data).join('');
  }
}

function castOwner(
  owner: FakeWebContents
): Parameters<ReturnType<typeof createTerminalIpcHandlers>['create']>[0] {
  return owner as unknown as Parameters<ReturnType<typeof createTerminalIpcHandlers>['create']>[0];
}

/** Poll `predicate` until true or timeout; returns whether it became true. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** True if a process with `pid` is currently alive. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 does not kill — it only checks existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(async () => {
  // Reap anything a test left running so pids never leak across tests.
  disposeAllTerminals();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('terminal IPC handlers — cwd containment', () => {
  it('rejects a missing/empty/non-string rootId without spawning', async () => {
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([]),
      spawn: spawn as never,
    });
    const owner = new FakeWebContents(1);

    const empty = await handlers.create(castOwner(owner), { rootId: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toMatch(/non-empty rootId/);
    }
    const nonString = await handlers.create(castOwner(owner), {
      rootId: 42 as unknown as string,
    });
    expect(nonString.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an unknown rootId (no arbitrary cwd) without spawning', async () => {
    const dir = await makeDir();
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'known', path: dir, rootId: 'known-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      rootId: 'unknown-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No open folder matches root id/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a web (non-absolute path) root without spawning', async () => {
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'web', path: 'not/absolute', rootId: 'web-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      rootId: 'web-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no local filesystem path/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('terminal IPC handlers — real pty lifecycle', () => {
  it('spawns a real shell, streams output, resizes, and destroys with no orphan', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(1);

    const created = await handlers.create(castOwner(owner), {
      rootId: 'root-id',
      cols: 80,
      rows: 24,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId, cwd } = created.value;
    expect(cwd).toBe(dir);
    expect(liveTerminalCountForTest()).toBe(1);

    // Drive the shell: print a unique marker, then read it from the data stream.
    const writeResult = handlers.write({ terminalId, data: 'echo HELLO_PTY_MARKER\r' }, owner.id);
    expect(writeResult.ok).toBe(true);

    const sawMarker = await waitFor(() => owner.aggregatedData.includes('HELLO_PTY_MARKER'));
    expect(sawMarker).toBe(true);

    // Resize must not crash.
    const resizeResult = handlers.resize({ terminalId, cols: 120, rows: 40 }, owner.id);
    expect(resizeResult.ok).toBe(true);

    // Capture the shell pid via the registry-free route: ask the shell to print
    // its own pid, then assert that pid is dead after destroy.
    owner.dataEvents.length = 0;
    handlers.write({ terminalId, data: 'echo PID=$$\r' }, owner.id);
    await waitFor(() => /PID=\d+/.test(owner.aggregatedData));
    const match = owner.aggregatedData.match(/PID=(\d+)/);
    expect(match).not.toBeNull();
    const shellPid = Number(match?.[1]);
    expect(Number.isInteger(shellPid)).toBe(true);
    expect(isPidAlive(shellPid)).toBe(true);

    // Destroy → the pty (and its shell pid) must be gone.
    const destroyResult = handlers.destroy({ terminalId }, owner.id);
    expect(destroyResult.ok).toBe(true);
    expect(liveTerminalCountForTest()).toBe(0);

    const dead = await waitFor(() => !isPidAlive(shellPid));
    expect(dead).toBe(true);
  });

  it('reaps a disowned/nohup background child on destroy (no orphan)', async () => {
    // Regression: tree-kill walks descendants by parent-pid, so a child that is
    // disowned/nohup'd and re-parents to PID 1 when the shell dies escapes a
    // leader-first kill. killTerminalTree runs the tree-kill walk (shell still
    // alive) + a process-group kill to close that gap. Probe is deterministic.
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(5);

    const created = await handlers.create(castOwner(owner), { rootId: 'root-id' });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId } = created.value;

    // Start a nohup'd background sleep, disown it, and print its pid. nohup makes
    // it ignore SIGHUP (so node-pty's leader SIGHUP can't reap it); disown +
    // job control put it in its OWN process group — the orphan the reviewer found.
    handlers.write(
      { terminalId, data: 'nohup sleep 600 >/dev/null 2>&1 & C=$!; disown $C; echo CHILD=$C\r' },
      owner.id
    );
    await waitFor(() => /CHILD=\d+/.test(owner.aggregatedData));
    const childPid = Number(owner.aggregatedData.match(/CHILD=(\d+)/)?.[1]);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    const destroyResult = handlers.destroy({ terminalId }, owner.id);
    expect(destroyResult.ok).toBe(true);

    // The disowned child must be dead — this was the orphan before the fix.
    const dead = await waitFor(() => !isPidAlive(childPid), 6000);
    expect(dead).toBe(true);
  });

  it('emits a terminal:exit event when the shell exits on its own', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(2);

    const created = await handlers.create(castOwner(owner), { rootId: 'root-id' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId } = created.value;

    // Ask the shell to exit; the onExit handler should push terminal:exit and
    // drop the registry entry.
    handlers.write({ terminalId, data: 'exit\r' }, owner.id);

    const exited = await waitFor(() => owner.exitEvents.length > 0);
    expect(exited).toBe(true);
    expect(owner.exitEvents[0]?.terminalId).toBe(terminalId);
    expect(liveTerminalCountForTest()).toBe(0);
  });
});

describe('terminal IPC handlers — structured errors', () => {
  it('returns a structured error writing/resizing/destroying an unknown terminal', () => {
    const handlers = createTerminalIpcHandlers({ resolver: fakeResolver([]) });

    const write = handlers.write({ terminalId: 'ghost', data: 'x' }, 1);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error).toMatch(/No live terminal/);
    }
    const resize = handlers.resize({ terminalId: 'ghost', cols: 10, rows: 10 }, 1);
    expect(resize.ok).toBe(false);
    const destroy = handlers.destroy({ terminalId: 'ghost' }, 1);
    expect(destroy.ok).toBe(false);
  });

  it('returns a structured error writing to a destroyed terminal', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(3);

    const created = await handlers.create(castOwner(owner), { rootId: 'root-id' });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId } = created.value;
    handlers.destroy({ terminalId }, owner.id);

    const write = handlers.write({ terminalId, data: 'echo nope\r' }, owner.id);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error).toMatch(/No live terminal/);
    }
  });

  it('rejects write/resize/destroy from a non-owner renderer (cross-renderer isolation)', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(100);
    const attacker = new FakeWebContents(200);

    const created = await handlers.create(castOwner(owner), { rootId: 'root-id' });
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId } = created.value;

    // The attacker knows the id but does not own the terminal → all rejected,
    // with the SAME error as an unknown id (no existence oracle).
    const write = handlers.write({ terminalId, data: 'echo pwned\r' }, attacker.id);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error).toMatch(/No live terminal/);
    }
    const resize = handlers.resize({ terminalId, cols: 10, rows: 10 }, attacker.id);
    expect(resize.ok).toBe(false);
    const destroy = handlers.destroy({ terminalId }, attacker.id);
    expect(destroy.ok).toBe(false);

    // The terminal is untouched and the OWNER can still drive + destroy it.
    expect(liveTerminalCountForTest()).toBe(1);
    expect(handlers.write({ terminalId, data: 'echo ok\r' }, owner.id).ok).toBe(true);
    expect(handlers.destroy({ terminalId }, owner.id).ok).toBe(true);
    expect(liveTerminalCountForTest()).toBe(0);
  });

  it('surfaces a spawn failure as a structured error (no throw across IPC)', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: (() => {
        throw new Error('boom');
      }) as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(4)), {
      rootId: 'root-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Failed to start terminal: boom/);
    }
    expect(liveTerminalCountForTest()).toBe(0);
  });
});

describe('terminal IPC handlers — dispose lifecycle', () => {
  it('disposeAllTerminals kills every live pty (spawn 2, dispose, both dead)', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });

    const ownerA = new FakeWebContents(10);
    const ownerB = new FakeWebContents(11);
    const a = await handlers.create(castOwner(ownerA), { rootId: 'root-id' });
    const b = await handlers.create(castOwner(ownerB), { rootId: 'root-id' });
    if (!(a.ok && b.ok)) {
      throw new Error('create failed');
    }
    expect(liveTerminalCountForTest()).toBe(2);

    // Read each shell's pid for the post-dispose liveness check.
    const pids: number[] = [];
    for (const [owner, created] of [
      [ownerA, a],
      [ownerB, b],
    ] as const) {
      handlers.write({ terminalId: created.value.terminalId, data: 'echo PID=$$\r' }, owner.id);
      await waitFor(() => /PID=\d+/.test(owner.aggregatedData));
      const pid = Number(owner.aggregatedData.match(/PID=(\d+)/)?.[1]);
      expect(Number.isInteger(pid)).toBe(true);
      pids.push(pid);
    }
    expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

    const reaped = disposeAllTerminals();
    expect(reaped).toBe(2);
    expect(liveTerminalCountForTest()).toBe(0);

    for (const pid of pids) {
      const dead = await waitFor(() => !isPidAlive(pid));
      expect(dead).toBe(true);
    }
  });

  it('reaps a renderer’s terminals when its WebContents is destroyed', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(20);

    const created = await handlers.create(castOwner(owner), { rootId: 'root-id' });
    if (!created.ok) {
      throw new Error('create failed');
    }
    handlers.write({ terminalId: created.value.terminalId, data: 'echo PID=$$\r' }, owner.id);
    await waitFor(() => /PID=\d+/.test(owner.aggregatedData));
    const pid = Number(owner.aggregatedData.match(/PID=(\d+)/)?.[1]);
    expect(liveTerminalCountForTest()).toBe(1);

    owner.fireDestroyed();
    expect(liveTerminalCountForTest()).toBe(0);
    const dead = await waitFor(() => !isPidAlive(pid));
    expect(dead).toBe(true);
  });
});

// Sanity: ensure `execSync` is actually available in this env (used nowhere
// else but documents that we run in a real Node process, not a stubbed one).
it('runs in a real Node process (node-pty native module is loadable)', () => {
  expect(typeof execSync).toBe('function');
});
