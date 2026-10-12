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
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalIpcHandlers,
  disposeAllTerminals,
  liveTerminalCountForTest,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '../terminal-ipc-handlers';
import type { WorkspaceRootResolver } from '../workspace-root-cwd';

// chmod-based EACCES fixtures don't deny root (uid 0) — same idiom as
// agent-ignore-boundary-holes.test.ts's `canDenyReads`.
const canDenyReads = process.platform !== 'win32' && process.getuid?.() !== 0;

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

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

/** Read a child-owned readiness file once it exists and contains a value. */
async function waitForFile(pathname: string, timeoutMs = 4000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fsPromises.readFile(pathname, 'utf8');
      if (value.length > 0) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
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
  await disposeAllTerminals();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
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

  it('spawns in a subdirectory of the root when a contained cwd is supplied', async () => {
    const dir = await makeDir();
    const nested = path.join(dir, '.claude', 'worktrees', 'bright-fox');
    await fsPromises.mkdir(nested, { recursive: true });
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(1);

    const created = await handlers.create(castOwner(owner), { cwd: nested, rootId: 'root-id' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    // The REPORTED cwd is the nested checkout, not the containing root — the
    // whole point of the parameter (a nested worktree must not get the parent
    // repo's shell).
    expect(created.value.cwd).toBe(await fsPromises.realpath(nested));
    handlers.destroy({ terminalId: created.value.terminalId }, owner.id);
  });

  it('rejects a cwd outside the root without spawning', async () => {
    const dir = await makeDir();
    const outside = await makeDir();
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      cwd: outside,
      rootId: 'root-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/outside the open folder/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a sibling-prefix cwd that only looks contained', async () => {
    // `<root>-evil` starts with `<root>` as a STRING but is not inside it. A
    // naive `startsWith(rootCwd)` check passes this; the separator-anchored
    // check does not. This is the falsifier for the containment predicate.
    const dir = await makeDir();
    const sibling = `${dir}-evil`;
    await fsPromises.mkdir(sibling, { recursive: true });
    createdDirs.push(sibling);
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      cwd: sibling,
      rootId: 'root-id',
    });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a relative, empty or non-directory cwd without spawning', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'hello.ts');
    await fsPromises.writeFile(file, 'export const value = 1;\n');
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });
    const owner = new FakeWebContents(1);

    const relative = await handlers.create(castOwner(owner), { cwd: 'sub', rootId: 'root-id' });
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.error).toMatch(/absolute/);
    }
    const empty = await handlers.create(castOwner(owner), { cwd: '   ', rootId: 'root-id' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toMatch(/non-empty cwd/);
    }
    const notDir = await handlers.create(castOwner(owner), { cwd: file, rootId: 'root-id' });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) {
      expect(notDir.error).toMatch(/not a directory/);
    }
    const missing = await handlers.create(castOwner(owner), {
      cwd: path.join(dir, 'nope'),
      rootId: 'root-id',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toMatch(/no longer exists/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  // BST-1457 PR review: a non-ENOENT realpath/stat failure (EACCES, ELOOP, …)
  // must never embed the offending absolute path in the error returned over
  // IPC — the module's own docblock forbids it, and use-terminal-session.ts
  // logs this string at error level (warn+) and shows it in a toast.
  it.skipIf(!canDenyReads)(
    'returns a path-free, categorized error for a non-ENOENT resolution failure (EACCES)',
    async () => {
      const dir = await makeDir();
      const restricted = path.join(dir, 'restricted');
      await fsPromises.mkdir(restricted);
      const nested = path.join(restricted, 'nested');
      // Deny traversal into `restricted` so realpath(nested) fails EACCES,
      // not ENOENT — the branch under test.
      await fsPromises.chmod(restricted, 0o000);
      const spawn = vi.fn();
      const handlers = createTerminalIpcHandlers({
        resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
        spawn: spawn as never,
      });

      try {
        const result = await handlers.create(castOwner(new FakeWebContents(1)), {
          cwd: nested,
          rootId: 'root-id',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatch(/EACCES/);
          expect(result.error).not.toContain(dir);
          expect(result.error).not.toContain(restricted);
          expect(result.error).not.toContain(nested);
        }
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        // Restore permissions so the afterEach `rm(recursive)` can clean up.
        await fsPromises.chmod(restricted, 0o700);
      }
    }
  );

  // BST-1457 PR review: when the mounted root is itself a filesystem root
  // (`/`), it is already sep-terminated. Appending another `path.sep` turns
  // the containment prefix into `//`, which no real descendant can ever
  // start with — every open-in-terminal request would be misreported as
  // "outside the open folder". Root=`/` is a real fixture here (any absolute
  // path is contained under it), not a mock.
  it('accepts a contained cwd when the root is the filesystem root ("/")', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: path.sep, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(1);

    const created = await handlers.create(castOwner(owner), { cwd: dir, rootId: 'root-id' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.value.cwd).toBe(await fsPromises.realpath(dir));
    handlers.destroy({ terminalId: created.value.terminalId }, owner.id);
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
      cols: 80,
      rootId: 'root-id',
      rows: 24,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(`create failed: ${created.error}`);
    }
    const { terminalId, cwd } = created.value;
    expect(cwd).toBe(dir);
    expect(terminalId).toMatch(
      /^pty-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(liveTerminalCountForTest()).toBe(1);

    // Drive the shell: print a unique marker, then read it from the data stream.
    const writeResult = handlers.write({ data: 'echo HELLO_PTY_MARKER\r', terminalId }, owner.id);
    expect(writeResult.ok).toBe(true);

    const sawMarker = await waitFor(() => owner.aggregatedData.includes('HELLO_PTY_MARKER'));
    expect(sawMarker).toBe(true);

    // Resize must not crash.
    const resizeResult = handlers.resize({ cols: 120, rows: 40, terminalId }, owner.id);
    expect(resizeResult.ok).toBe(true);

    // Capture the shell pid via the registry-free route: ask the shell to print
    // its own pid, then assert that pid is dead after destroy.
    owner.dataEvents.length = 0;
    handlers.write({ data: 'echo PID=$$\r', terminalId }, owner.id);
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
    // alive) + a process-group kill to close that gap.
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
    const readyPath = path.join(dir, 'child-ready');
    const childScriptPath = path.join(dir, 'long-lived-child.cjs');
    await fsPromises.writeFile(
      childScriptPath,
      "const fs = require('node:fs');\nconst tmp = process.argv[2] + '.tmp';\nfs.writeFileSync(tmp, String(process.pid));\nfs.renameSync(tmp, process.argv[2]);\nsetTimeout(() => process.exit(0), 600_000);\n"
    );

    // The child itself writes readiness only after Node has successfully exec'd
    // and established its long-lived event loop. A shell-owned `$!` marker alone
    // races child startup: under process pressure the attempted child can exit
    // before the test observes it, producing a dead pid unrelated to destroy.
    // nohup makes the live child ignore SIGHUP; disown/job control put it in its
    // own process group — the orphan that terminal destroy must reap.
    handlers.write(
      {
        data: `nohup ${quotePosixShellArg(process.execPath)} ${quotePosixShellArg(childScriptPath)} ${quotePosixShellArg(readyPath)} >/dev/null 2>&1 & C=$!; disown $C; echo DISOWNED=$C\r`,
        terminalId,
      },
      owner.id
    );
    expect(await waitFor(() => /DISOWNED=\d+/.test(owner.aggregatedData))).toBe(true);
    const readyPid = await waitForFile(readyPath);
    expect(readyPid).not.toBeNull();
    const childPid = Number(readyPid);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(owner.aggregatedData).toMatch(new RegExp(`DISOWNED=${childPid}\\b`));
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
    handlers.write({ data: 'exit\r', terminalId }, owner.id);

    const exited = await waitFor(() => owner.exitEvents.length > 0);
    expect(exited).toBe(true);
    expect(owner.exitEvents[0]?.terminalId).toBe(terminalId);
    expect(liveTerminalCountForTest()).toBe(0);
  });
});

describe('terminal IPC handlers — structured errors', () => {
  it('returns a structured error writing/resizing/destroying an unknown terminal', () => {
    const handlers = createTerminalIpcHandlers({ resolver: fakeResolver([]) });

    const write = handlers.write({ data: 'x', terminalId: 'ghost' }, 1);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error).toMatch(/No live terminal/);
    }
    const resize = handlers.resize({ cols: 10, rows: 10, terminalId: 'ghost' }, 1);
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

    const write = handlers.write({ data: 'echo nope\r', terminalId }, owner.id);
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
    const write = handlers.write({ data: 'echo pwned\r', terminalId }, attacker.id);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error).toMatch(/No live terminal/);
    }
    const resize = handlers.resize({ cols: 10, rows: 10, terminalId }, attacker.id);
    expect(resize.ok).toBe(false);
    const destroy = handlers.destroy({ terminalId }, attacker.id);
    expect(destroy.ok).toBe(false);

    // The terminal is untouched and the OWNER can still drive + destroy it.
    expect(liveTerminalCountForTest()).toBe(1);
    expect(handlers.write({ data: 'echo ok\r', terminalId }, owner.id).ok).toBe(true);
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

  // Privacy: docs/agents/platform-contracts.md forbids ever logging/persisting
  // cwd. This branch's Flight Recorder P2a durable NDJSON backstop mirrors
  // every warn+ `logger.*` call to a plaintext file on disk, so a raw `cwd`
  // field here would have made a workspace root's real filesystem path
  // durable and greppable. Assert the emitted record carries only
  // non-reversible metadata (segment depth + a hash prefix), never the path.
  it('never logs the raw cwd on a spawn failure — only depth + fingerprint', async () => {
    const dir = await makeDir();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: (() => {
        throw new Error('boom');
      }) as never,
    });

    setLogLevel(LogLevel.ERROR);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      captured.push(record);
    });
    try {
      await handlers.create(castOwner(new FakeWebContents(4)), { rootId: 'root-id' });

      const spawnFailureRecord = captured.find(
        (record) => record.message === 'Failed to spawn pty'
      );
      expect(spawnFailureRecord).toBeDefined();
      const context = spawnFailureRecord?.args.find(
        (arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null
      );
      expect(context).toEqual(
        expect.objectContaining({
          cwdDepth: expect.any(Number),
          cwdSha256Prefix: expect.any(String),
          error: 'boom',
          shell: expect.any(String),
        })
      );
      expect(context).not.toHaveProperty('cwd');
      expect(JSON.stringify(captured)).not.toContain(dir);
    } finally {
      removeListener();
      setLogLevel(LogLevel.WARN);
    }
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
      handlers.write({ data: 'echo PID=$$\r', terminalId: created.value.terminalId }, owner.id);
      await waitFor(() => /PID=\d+/.test(owner.aggregatedData));
      const pid = Number(owner.aggregatedData.match(/PID=(\d+)/)?.[1]);
      expect(Number.isInteger(pid)).toBe(true);
      pids.push(pid);
    }
    expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

    const reaped = await disposeAllTerminals();
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
    handlers.write({ data: 'echo PID=$$\r', terminalId: created.value.terminalId }, owner.id);
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
