/**
 * Safety coverage for the desktop `brainstrike.executeCommand` tool.
 *
 * These run in CI (unlike rg-backed grep) because `/bin/sh` is always present.
 * The critical tests use REAL subprocesses and assert the process tree is
 * actually dead after a timeout/abort — a leaking shell tool is unacceptable,
 * so the no-orphan and process-group-kill proofs are the heart of this file.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NATIVE_TOOL_RESULT_CHAR_BUDGET, type RuntimeData } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import {
  buildTruncationMarker,
  disposeLiveChildProcesses,
  type ExecuteCommandToolResult,
  fitHeadAndTailToCharBudget,
  resolveShellInvocation,
  runExecuteCommand,
  type ShellOutputStreamPart,
} from '../../assistant-server/execute-command-tool';
import {
  readPidWhenWritten,
  requireTool,
  requireToolExecute,
  singleRootRuntime,
  waitForPidDead,
} from './_tool-test-helpers';

const { loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: loggerInfoMock,
      warn: loggerWarnMock,
    }),
  };
});

const execFileAsync = promisify(execFile);

const createdRoots: string[] = [];

async function makeWorkspace(prefix = 'brainstrike-exec-unit-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink does not trip containment.
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

function singleRoot(rootPath: string): RuntimeData {
  return singleRootRuntime(rootPath);
}

function requireExecuteCommandModelOutput(
  tools: NonNullable<RuntimeData['mastraTools']>
): (output: unknown) => { type: 'text'; value: string } {
  const tool = requireTool(tools, 'brainstrike.executeCommand');
  const toModelOutput = (tool as { toModelOutput?: (output: unknown) => unknown }).toModelOutput;
  if (typeof toModelOutput !== 'function') {
    throw new Error("Expected tool 'brainstrike.executeCommand' to have a model output projection");
  }
  return (output: unknown) => toModelOutput.call(tool, output) as { type: 'text'; value: string };
}

beforeEach(() => {
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
});

afterEach(async () => {
  disposeLiveChildProcesses();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('fitHeadAndTailToCharBudget — character-based retention', () => {
  it('returns under-budget text unchanged without reporting truncation', () => {
    const text = 'alpha\nbeta\ngamma';

    expect(fitHeadAndTailToCharBudget(text, text.length)).toEqual({
      text,
      truncated: false,
    });
  });

  it('keeps a 40/60 head-and-tail split with an exact omission marker', () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `line-${index.toString().padStart(2, '0')}`
    ).join('\n');

    const result = fitHeadAndTailToCharBudget(text, 80);

    expect(text).toHaveLength(159);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(80);
    expect(result.text.startsWith(text.slice(0, 10))).toBe(true);
    // Uses the same marker builder the production code calls — one definition
    // for the model-facing marker contract, not a duplicated literal.
    expect(result.text).toContain(buildTruncationMarker(133, 159));
    expect(result.text.endsWith(text.slice(-16))).toBe(true);
  });

  it('keeps non-empty head and tail content from one oversized line', () => {
    const text = `${'H'.repeat(100)}${'M'.repeat(100)}${'T'.repeat(100)}`;

    const result = fitHeadAndTailToCharBudget(text, 100);

    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(100);
    expect(result.text.startsWith('H'.repeat(18))).toBe(true);
    expect(result.text).toContain(buildTruncationMarker(254, 300));
    expect(result.text.endsWith('T'.repeat(28))).toBe(true);
  });

  it('never splits a UTF-16 surrogate pair at the head or tail boundary', () => {
    // U+1F600 (😀) is an astral character: two UTF-16 code units. These exact
    // padding lengths were verified (see PR #2314 review thread) to put the
    // computed 40%/60% cut points AT index 8 (inside the first emoji's pair,
    // splitting off its lone high surrogate) and at the low surrogate of the
    // second emoji (splitting off its lone low surrogate) — reproducing the
    // naive-slice bug before asserting the fix.
    const emoji = '😀';
    const text = `${'a'.repeat(7)}${emoji}${'b'.repeat(83)}${emoji}${'c'.repeat(11)}`;
    const charBudget = 74;

    const result = fitHeadAndTailToCharBudget(text, charBudget);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(charBudget);
    // A lone (unpaired) surrogate has no valid UTF-8 encoding; encoding then
    // decoding replaces it with U+FFFD. Round-tripping through UTF-8 is the
    // precise, encoding-agnostic proof that no boundary left a broken half.
    const roundTripped = Buffer.from(result.text, 'utf8').toString('utf8');
    expect(roundTripped).toBe(result.text);
    expect(roundTripped).not.toContain('�');
  });

  it('returns empty text (not a mangled marker fragment) when the budget cannot hold the marker', () => {
    const text = 'x'.repeat(1000);
    // The marker for a 1000-char input is ~40 chars; a budget smaller than
    // that cannot honestly retain any content.
    const tinyBudget = 10;

    const result = fitHeadAndTailToCharBudget(text, tinyBudget);

    expect(result).toEqual({ text: '', truncated: true });
  });
});

describe('runExecuteCommand — happy path', () => {
  it('runs echo and surfaces exitCode 0 with stdout', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'echo hello-world' }, singleRoot(root));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('hello-world');
    expect(result.signal).toBeNull();
    expect(result.cwd).toBe(root);
    expect(typeof result.durationMs).toBe('number');
    expect(result.rootId).toBe(root);
    expect(result.openRoots).toBeUndefined();
    expect(result.ambiguousRootNames).toBeUndefined();
  });

  it('starts in the workspace root by default (pwd === root)', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'pwd' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });

  it('executes and projects through the registered desktop tool', async () => {
    const root = await makeWorkspace();
    const tools = buildDesktopAssistantTools(singleRoot(root));
    const execute = requireToolExecute<ExecuteCommandToolResult>(
      tools,
      'brainstrike.executeCommand'
    );
    const toModelOutput = requireExecuteCommandModelOutput(tools);

    const result = await execute({ command: 'echo hello' });

    expect(toModelOutput(result)).toEqual({
      type: 'text',
      value: `exec exit=0 ${(result.durationMs / 1000).toFixed(1)}s\nhello\n`,
    });
  });
});

describe('runExecuteCommand — root topology', () => {
  it('threads same-name multi-root topology and the selected root id', async () => {
    const rootA = await makeWorkspace('brainstrike-exec-multiroot-a-');
    const rootB = await makeWorkspace('brainstrike-exec-multiroot-b-');
    const runtimeData = {
      workspaceRoots: [
        { displayName: 'Twin', path: rootA, rootId: 'root-a' },
        { displayName: 'twin', path: rootB, rootId: 'root-b' },
      ],
    } as RuntimeData;

    const result = await runExecuteCommand(
      { command: 'echo selected', root: 'root-a' },
      runtimeData
    );

    expect(result.rootId).toBe('root-a');
    expect(result.openRoots).toBe(2);
    expect(result.ambiguousRootNames).toEqual(['twin']);
  });
});

describe('runExecuteCommand — command echo bounding', () => {
  it('echoes a command at the 200-character boundary unchanged', async () => {
    const root = await makeWorkspace();
    const command = `printf ok #${'x'.repeat(200 - 'printf ok #'.length)}`;

    const result = await runExecuteCommand({ command }, singleRoot(root));

    expect(command).toHaveLength(200);
    expect(result.command).toBe(command);
  });

  it('echoes only the first 200 characters plus an explicit truncation note', async () => {
    const root = await makeWorkspace();
    const command = `printf ok #${'x'.repeat(240)}`;
    const note = '… [command truncated: full command is in the tool call input]';

    const result = await runExecuteCommand({ command }, singleRoot(root));

    expect(command.length).toBeGreaterThan(200);
    expect(result.command.slice(0, 200)).toBe(command.slice(0, 200));
    expect(result.command.slice(200)).toBe(note);
    expect(result.command).not.toContain(command);
  });
});

describe('runExecuteCommand — truncated flag (no false positive on empty streams)', () => {
  // Regression guard: an ABSENT stream must never flip the overall result to
  // truncated + a bogus "Output was truncated…" hint on the COMMON case
  // (output on only one stream, or a silent command). Keep the raw
  // hasStdout/hasStderr gate even as fitting internals evolve.

  it('reports truncated=false when only stdout has output (empty stderr)', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'echo hi' }, singleRoot(root));
    expect(result.stdout).toContain('hi');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it('reports truncated=false for a silent command (both streams empty)', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'exit 0' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it('still reports truncated=true when stdout genuinely exceeds the budget', async () => {
    const root = await makeWorkspace();
    // ~50k numbered lines vastly exceeds the per-stream char budget.
    const result = await runExecuteCommand({ command: 'seq 1 50000' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBeTruthy();
  });
});

describe('runExecuteCommand — non-zero exit (surfaced, not swallowed)', () => {
  it('surfaces a non-zero exit code', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'exit 3' }, singleRoot(root));
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('redacts non-zero command text from logs', async () => {
    const root = await makeWorkspace();
    await runExecuteCommand(
      { command: 'echo OPENAI_API_KEY=sk-sensitive >&2; exit 7' },
      singleRoot(root)
    );

    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Command exited non-zero',
      expect.objectContaining({
        command: { redacted: true },
        cwd: { redacted: true },
        exitCode: 7,
      })
    );
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain('sk-sensitive');
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain(root);
  });

  it('captures stderr for a failing command', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'echo oops 1>&2; exit 1' }, singleRoot(root));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('oops');
  });
});

describe('runExecuteCommand — timeout + no orphan (CRITICAL)', () => {
  it('times out a long sleep and kills the process so no orphan survives', async () => {
    const root = await makeWorkspace();
    // Capture the spawned shell pid via the live registry indirectly: run a
    // command that writes its own group pid to a file, then assert that pid is
    // dead after the timeout. We write $$ (the shell pid == group leader pid).
    const pidFile = path.join(root, 'shell.pid');
    const result = await runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 500 },
      singleRoot(root)
    );

    expect(result.timedOut).toBe(true);
    // Killed by signal → exitCode is null (never silently coerced to 0).
    expect(result.exitCode).toBeNull();

    const shellPid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(Number.isInteger(shellPid)).toBe(true);
    // The shell pid must be gone — the timeout killed the whole tree.
    expect(await waitForPidDead(shellPid)).toBe(true);
  });

  it('redacts timed-out command text from logs', async () => {
    const root = await makeWorkspace();

    await runExecuteCommand(
      { command: 'echo OPENAI_API_KEY=sk-sensitive; sleep 30', timeoutMs: 500 },
      singleRoot(root)
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Command timed out and its process tree was killed',
      expect.objectContaining({
        command: { redacted: true },
        cwd: { redacted: true },
        timeoutMs: 500,
      })
    );
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('sk-sensitive');
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain(root);
  });
});

describe('runExecuteCommand — process-group kill reaps the grandchild (CRITICAL)', () => {
  it('kills a background grandchild on timeout, not just the shell', async () => {
    const root = await makeWorkspace();
    const childPidFile = path.join(root, 'child.pid');
    // The shell backgrounds a `sleep 30` (the grandchild) and records ITS pid,
    // then waits. On timeout, a shell-only kill would leave the grandchild
    // running; the process-GROUP kill must reap it too.
    const result = await runExecuteCommand(
      {
        command: `sleep 30 & echo $! > "${childPidFile}"; wait`,
        timeoutMs: 500,
      },
      singleRoot(root)
    );

    expect(result.timedOut).toBe(true);

    const grandchildPid = Number.parseInt(
      (await fsPromises.readFile(childPidFile, 'utf8')).trim(),
      10
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // The backgrounded grandchild must ALSO be dead — proves the group kill.
    expect(await waitForPidDead(grandchildPid)).toBe(true);
  });
});

describe('runExecuteCommand — abort kills the tree', () => {
  it('kills the process tree when the abort signal fires', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'abort.pid');
    const controller = new AbortController();
    const run = runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 30_000 },
      singleRoot(root),
      { signal: controller.signal }
    );
    // Give the shell time to start and write its pid, then abort.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    const result = await run;
    expect(result.timedOut).toBe(false);
    const shellPid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(await waitForPidDead(shellPid)).toBe(true);
  });
});

describe('runExecuteCommand — output bounding (no unbounded result)', () => {
  it('truncates huge output with a hint instead of returning it all', async () => {
    const root = await makeWorkspace();
    // ~50k numbered lines — far above the model budget but below the raw cap.
    const result = await runExecuteCommand(
      { command: 'seq 1 50000', timeoutMs: 30_000 },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBeTruthy();
    // The serialized result must stay inside the native tool result budget —
    // the actual transport guard, not an arbitrary looser number. Budgeting
    // is done on RAW chars while this guard measures SERIALIZED chars, so
    // this also catches JSON-escaping blowing past the budget on the edge.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(NATIVE_TOOL_RESULT_CHAR_BUDGET);
    expect(result.stdout).toContain('[… output truncated:');
    // Both the early diagnostic context and the most-recent output survive.
    expect(result.stdout.startsWith('1\n2\n3\n')).toBe(true);
    expect(result.stdout.endsWith('49999\n50000\n')).toBe(true);
  });

  it('describes head+tail retention in the truncation hint (not stale tail-only wording)', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand(
      { command: 'seq 1 50000', timeoutMs: 30_000 },
      singleRoot(root)
    );

    expect(result.truncated).toBe(true);
    // Regression guard: the hint must describe the CURRENT retention shape.
    // It must not push the model toward `| tail -n N`, which would discard
    // the early head content this feature exists to preserve.
    expect(result.hint).toContain('start and end of each stream');
    expect(result.hint).not.toContain('most recent lines');
    expect(result.hint).not.toContain('| tail -n N');
  });
});

describe('runExecuteCommand — ANSI stripping', () => {
  it('strips ANSI color/escape codes from stdout (red text, no escapes)', async () => {
    const root = await makeWorkspace();
    // printf interprets the \033 (ESC) escapes, emitting a real coloured string:
    // ESC[31m red ESC[0m. The result must contain the visible text without any
    // escape codes (no ESC byte, no "[31m"/"[0m" sequences).
    const result = await runExecuteCommand(
      { command: String.raw`printf '\033[31mred\033[0m\n'` },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('red');
    // No raw ESC byte (0x1b) and no SGR sequences survive into model-facing text.
    const ESC = String.fromCharCode(27);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).not.toContain('[31m');
    expect(result.stdout).not.toContain('[0m');
  });

  it('strips ANSI from stderr too', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand(
      { command: String.raw`printf '\033[33mwarn\033[0m\n' 1>&2` },
      singleRoot(root)
    );
    const ESC = String.fromCharCode(27);
    expect(result.stderr).toContain('warn');
    expect(result.stderr).not.toContain(ESC);
    expect(result.stderr).not.toContain('[33m');
  });
});

describe('runExecuteCommand — cwd containment', () => {
  it('rejects an absolute cwd outside the workspace root as a ToolInputError', async () => {
    const root = await makeWorkspace();
    const rejection = runExecuteCommand({ command: 'pwd', cwd: '/tmp' }, singleRoot(root));
    // The guard only preserves the bounded, model-correctable message for
    // ToolInputError; a plain Error would be redacted to a generic tool_failed,
    // hiding the actionable "outside the workspace root" diagnosis.
    await expect(rejection).rejects.toThrow(ToolInputError);
    await expect(rejection).rejects.toThrow(/outside the workspace root/i);
  });

  it('rejects a relative cwd that escapes the root as a ToolInputError', async () => {
    const root = await makeWorkspace();
    const rejection = runExecuteCommand({ command: 'pwd', cwd: '../..' }, singleRoot(root));
    await expect(rejection).rejects.toThrow(ToolInputError);
    await expect(rejection).rejects.toThrow(/outside the workspace root/i);
  });

  it('rejects a nonexistent cwd as a ToolInputError naming the requested cwd', async () => {
    const root = await makeWorkspace();
    const rejection = runExecuteCommand({ command: 'pwd', cwd: 'no-such-dir' }, singleRoot(root));
    await expect(rejection).rejects.toThrow(ToolInputError);
    await expect(rejection).rejects.toThrow(/cwd "no-such-dir" does not exist/i);
  });

  it('accepts a cwd inside the root and starts there', async () => {
    const root = await makeWorkspace();
    const sub = path.join(root, 'pkg', 'src');
    await fsPromises.mkdir(sub, { recursive: true });
    const result = await runExecuteCommand({ command: 'pwd', cwd: 'pkg/src' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(await fsPromises.realpath(sub));
  });

  it('throws when no folder is open in the workspace as a ToolInputError', async () => {
    const rejection = runExecuteCommand({ command: 'echo hi' }, undefined);
    await expect(rejection).rejects.toThrow(ToolInputError);
    await expect(rejection).rejects.toThrow(/No folder is open/i);
  });
});

describe('disposeLiveChildProcesses — shutdown reaping', () => {
  it('reaps a live child started by a never-resolving run', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'dispose.pid');
    // Start a long run but DO NOT await it; capture the pid from the file.
    const run = runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 30_000 },
      singleRoot(root)
    );
    // Wait for the shell to write its pid.
    const shellPid = await readPidWhenWritten(pidFile);

    const reaped = disposeLiveChildProcesses();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await waitForPidDead(shellPid)).toBe(true);
    // The run still settles (killed → close event) so we never leak a promise.
    await run;
  });
});

// A tiny smoke test that the shell really executes node, proving the tool is
// useful for the agent's real workflows (node -e is a common agent command).
describe('runExecuteCommand — runs node', () => {
  it('runs `node -e` and returns its stdout', async () => {
    const root = await makeWorkspace();
    // Confirm node is on PATH in this CI before asserting (no silent skip).
    await execFileAsync('node', ['-e', 'process.stdout.write("ok")']);
    const result = await runExecuteCommand(
      { command: 'node -e "process.stdout.write(String(1+1))"' },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2');
  });
});

describe('runExecuteCommand — incremental streaming via the stream callback', () => {
  it('streams stdout parts incrementally in order while the process runs', async () => {
    const root = await makeWorkspace();
    const parts: ShellOutputStreamPart[] = [];
    const result = await runExecuteCommand(
      {
        // Emit three markers spaced in time so they arrive as distinct pipe reads
        // (not one coalesced buffer) — proving the output streams as it is produced.
        command: `printf 'ALPHA\n'; sleep 0.15; printf 'BRAVO\n'; sleep 0.15; printf 'CHARLIE\n'`,
        timeoutMs: 30_000,
      },
      singleRoot(root),
      { stream: (part) => parts.push(part) }
    );

    // The final captured result is still complete and correct.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ALPHA');
    expect(result.stdout).toContain('CHARLIE');

    // At least one incremental part was streamed, all tagged stdout, and the
    // concatenation preserves the emission order (ALPHA before BRAVO before CHARLIE).
    const stdoutParts = parts.filter((part) => part.stream === 'stdout');
    expect(stdoutParts.length).toBeGreaterThanOrEqual(1);
    const streamed = stdoutParts.map((part) => part.chunk).join('');
    expect(streamed.indexOf('ALPHA')).toBeLessThan(streamed.indexOf('BRAVO'));
    expect(streamed.indexOf('BRAVO')).toBeLessThan(streamed.indexOf('CHARLIE'));
    // No incremental part is ever flagged truncated on a small run.
    expect(parts.some((part) => part.truncated)).toBe(false);
  });

  it('streams stderr parts tagged as stderr', async () => {
    const root = await makeWorkspace();
    const parts: ShellOutputStreamPart[] = [];
    await runExecuteCommand(
      { command: `printf 'to-stderr\n' 1>&2`, timeoutMs: 30_000 },
      singleRoot(root),
      { stream: (part) => parts.push(part) }
    );
    const stderrStreamed = parts
      .filter((part) => part.stream === 'stderr')
      .map((part) => part.chunk)
      .join('');
    expect(stderrStreamed).toContain('to-stderr');
  });

  it('caps the total streamed volume, emits a truncation notice, and leaves no orphan', async () => {
    const root = await makeWorkspace();
    const parts: ShellOutputStreamPart[] = [];
    // Emit ~2 MB to stdout — far above the streaming cap AND the capture cap.
    const result = await runExecuteCommand(
      {
        command: `node -e "process.stdout.write('z'.repeat(2*1024*1024))"`,
        timeoutMs: 30_000,
      },
      singleRoot(root),
      { stream: (part) => parts.push(part) }
    );

    expect(result.exitCode).toBe(0);

    // Streaming stopped at the cap: exactly one truncation notice was emitted,
    // and the total streamed volume is bounded (does not equal the 2 MB emitted).
    const truncationNotices = parts.filter((part) => part.truncated);
    expect(truncationNotices).toHaveLength(1);
    const totalStreamed = parts.reduce((sum, part) => sum + part.chunk.length, 0);
    expect(totalStreamed).toBeLessThan(2 * 1024 * 1024);

    // No leaked child: after the run settles nothing remains in the live registry.
    expect(disposeLiveChildProcesses()).toBe(0);
  });

  it('still tears the tree down on timeout while streaming is active (no leak)', async () => {
    const root = await makeWorkspace();
    const parts: ShellOutputStreamPart[] = [];
    const pidFile = path.join(root, 'stream-timeout.pid');
    const result = await runExecuteCommand(
      {
        // Stream some output, record the shell pid, then hang so the timeout fires.
        command: `echo $$ > "${pidFile}"; printf 'early\n'; sleep 30`,
        timeoutMs: 600,
      },
      singleRoot(root),
      { stream: (part) => parts.push(part) }
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // Output produced before the timeout still streamed.
    expect(parts.map((part) => part.chunk).join('')).toContain('early');
    // The SIGTERM→SIGKILL teardown still reaps the tree with streaming active.
    const shellPid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(await waitForPidDead(shellPid)).toBe(true);
  });
});

describe('resolveShellInvocation — per-platform shell selection', () => {
  const originalShell = process.env['SHELL'];
  const originalComSpec = process.env['ComSpec'];

  afterEach(() => {
    if (originalShell === undefined) {
      // must truly unset env var, not assign "undefined"
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = originalShell;
    }
    if (originalComSpec === undefined) {
      // must truly unset env var, not assign "undefined"
      delete process.env['ComSpec'];
    } else {
      process.env['ComSpec'] = originalComSpec;
    }
  });

  it('uses cmd.exe with /d /s /c on win32 (NOT /bin/sh — the ENOENT bug)', () => {
    // must truly unset env var, not assign "undefined"
    delete process.env['SHELL']; // SHELL is normally unset on Windows.
    process.env['ComSpec'] = 'C:\\Windows\\System32\\cmd.exe';
    const { shell, args } = resolveShellInvocation('echo hi', 'win32');
    expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', 'echo hi']);
    expect(shell).not.toBe('/bin/sh');
  });

  it('falls back to cmd.exe on win32 when ComSpec is unset', () => {
    // must truly unset env var, not assign "undefined"
    delete process.env['ComSpec'];
    const { shell, args } = resolveShellInvocation('echo hi', 'win32');
    expect(shell).toBe('cmd.exe');
    expect(args[0]).toBe('/d');
  });

  it('uses $SHELL with -c on POSIX (darwin/linux)', () => {
    process.env['SHELL'] = '/usr/bin/zsh';
    const darwin = resolveShellInvocation('echo hi', 'darwin');
    expect(darwin.shell).toBe('/usr/bin/zsh');
    expect(darwin.args).toEqual(['-c', 'echo hi']);
    const linux = resolveShellInvocation('echo hi', 'linux');
    expect(linux.args).toEqual(['-c', 'echo hi']);
  });

  it('falls back to /bin/sh on POSIX when SHELL is unset', () => {
    // must truly unset env var, not assign "undefined"
    delete process.env['SHELL'];
    const { shell, args } = resolveShellInvocation('echo hi', 'linux');
    expect(shell).toBe('/bin/sh');
    expect(args).toEqual(['-c', 'echo hi']);
  });
});

describe('runExecuteCommand — abort before spawn (already-aborted signal)', () => {
  it('never spawns and rejects when the signal is already aborted', async () => {
    const root = await makeWorkspace();
    const marker = path.join(root, 'should-not-exist.marker');
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE the call — simulates abort during cwd resolve.

    await expect(
      runExecuteCommand({ command: `echo ran > "${marker}"` }, singleRoot(root), {
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted before execution/i);

    // Proof it never spawned: the marker the command would write does not exist.
    await expect(fsPromises.access(marker)).rejects.toThrow();
  });
});

describe('runExecuteCommand — credential isolation', () => {
  it('does not expose provider credentials to non-interactive command children', async () => {
    const root = await makeWorkspace();
    const priorCredential = process.env['OPENAI_API_KEY'];
    const priorOrdinaryValue = process.env['BRAINSTRIKE_COMMAND_TEST_VALUE'];
    process.env['OPENAI_API_KEY'] = 'sentinel-command-canary';
    process.env['BRAINSTRIKE_COMMAND_TEST_VALUE'] = 'ordinary-value';

    try {
      const result = await runExecuteCommand(
        {
          command:
            'node -e "process.stdout.write(JSON.stringify({' +
            'credential:process.env.OPENAI_API_KEY??null,' +
            'ordinary:process.env.BRAINSTRIKE_COMMAND_TEST_VALUE??null' +
            '}))"',
        },
        singleRoot(root)
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        credential: null,
        ordinary: 'ordinary-value',
      });
    } finally {
      if (priorCredential === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      } else {
        process.env['OPENAI_API_KEY'] = priorCredential;
      }
      if (priorOrdinaryValue === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_COMMAND_TEST_VALUE');
      } else {
        process.env['BRAINSTRIKE_COMMAND_TEST_VALUE'] = priorOrdinaryValue;
      }
    }
  });
});

describe('runExecuteCommand — reaps background work the shell left running (CRITICAL)', () => {
  it('kills a backgrounded grandchild even when the shell exits 0', async () => {
    const root = await makeWorkspace();
    const childPidFile = path.join(root, 'bg.pid');
    // The shell backgrounds a long sleep, records its pid, and EXITS 0 normally
    // (no timeout, no abort). Without best-effort group-reap-on-exit, that
    // detached grandchild would survive the tool returning.
    const result = await runExecuteCommand(
      { command: `sleep 30 & echo $! > "${childPidFile}"; exit 0`, timeoutMs: 30_000 },
      singleRoot(root)
    );

    // The shell itself exited cleanly (0), not via our teardown.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    const grandchildPid = Number.parseInt(
      (await fsPromises.readFile(childPidFile, 'utf8')).trim(),
      10
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // The backgrounded grandchild must be dead — best-effort group reap on exit.
    expect(await waitForPidDead(grandchildPid)).toBe(true);
  });
});

describe('runExecuteCommand — fair stdout/stderr tail split', () => {
  it('keeps a stdout tail even when stderr floods the output', async () => {
    const root = await makeWorkspace();
    // Flood stderr with ~100k lines, then print the real result to stdout LAST.
    // The old stderr-first budgeting would drop stdout entirely; the fair split
    // must preserve the stdout marker.
    const result = await runExecuteCommand(
      {
        command: 'seq 1 100000 | sed "s/.*/noise/" 1>&2; echo RESULT_MARKER',
        timeoutMs: 30_000,
      },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    // stdout is preserved (not starved by the chatty stderr).
    expect(result.stdout).toContain('RESULT_MARKER');
    // stderr still gets a (bounded) tail.
    expect(result.stderr).toContain('noise');
    // The whole serialized result stays within the model budget.
    expect(JSON.stringify(result).length).toBeLessThan(14_000);
  });
});
