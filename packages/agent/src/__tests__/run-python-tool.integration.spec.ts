import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';
import { describe, expect, it } from 'vitest';
import type { CodeExecutorHostCapabilities } from '../code-execution';
import { createFenceExecutor } from '../fence/fence-executor';
import { createRunPythonTool, type RunPythonResult } from '../tools/run-python-tool';
import {
  describeFenceHostSkipReason,
  refuseToSkipInAPromisedLane,
} from './fixtures/fence-host-gate';

/**
 * BST-1067 acceptance proofs for `run_python` against the REAL OS fence and a
 * REAL interpreter — the ticket's four required cases (happy-path compute,
 * denied filesystem write, denied network, timeout) exercised through the
 * actual tool rather than the executor directly.
 *
 * Skips name exactly what is missing, never by weakening an assertion.
 */

function resolvePython(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    try {
      const resolved = execFileSync(platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
      })
        .split('\n')[0]
        ?.trim();
      if (resolved && existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Not on PATH — try the next candidate.
    }
  }
  return;
}

const pythonPath = resolvePython();
const PROBE_HOST = 'example.com';

/**
 * The network-deny proof needs a POSITIVE CONTROL: on a host with no egress at
 * all, a blocked connection is indistinguishable from an unreachable one, and
 * the deny assertion would pass vacuously while proving nothing.
 */
async function isNetworkReachable(): Promise<boolean> {
  try {
    const response = await fetch(`https://${PROBE_HOST}`, { signal: AbortSignal.timeout(15_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function describeSkipReason(): Promise<string | undefined> {
  const hostReason = await describeFenceHostSkipReason();
  if (hostReason) {
    return hostReason;
  }
  if (!pythonPath) {
    return 'no python3/python interpreter is on PATH';
  }
  if (!(await isNetworkReachable())) {
    return `https://${PROBE_HOST} is not reachable unsandboxed, so the network-deny assertion would pass vacuously`;
  }
  return;
}

// Through the shared gate LAST, once every prerequisite has had its say: in a
// lane that declared BRAINSTRIKE_FENCE_DEPS_REQUIRED this throws instead of
// skipping, for the interpreter and reachability reasons as well as the srt
// dependency one — each of them skips this suite just as completely.
const skipReason = refuseToSkipInAPromisedLane(
  'run-python-tool.integration',
  await describeSkipReason()
);
if (skipReason) {
  console.warn(`[run-python-tool.integration] SKIPPED — ${skipReason}`);
}

function fenceHost(): CodeExecutorHostCapabilities {
  return {
    fence: (signal) =>
      createFenceExecutor(
        { interpreters: { python: { command: pythonPath as string, scriptExtension: 'py' } } },
        signal
      ),
  };
}

async function runPython(
  code: string,
  options: { timeoutMs?: number } = {}
): Promise<RunPythonResult> {
  const tool = createRunPythonTool({
    resolveHost: async () => fenceHost(),
  });
  const result = await tool.execute({
    code,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return result as RunPythonResult;
}

describe.skipIf(skipReason !== undefined)('run_python against the real OS fence', () => {
  it('runs agent Python and returns its stdout (the milestone case)', async () => {
    const result = await runPython('print(sum(range(10)))');
    expect(result).toMatchObject({ exitCode: 0, kind: 'completed' });
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    expect(result.stdout.trim()).toBe('45');
    expect(result.stderr).toBe('');
  });

  it('lets the script write inside its scratch dir', async () => {
    // Positive control for the denial below: proves the write test fails
    // because of WHERE it wrote, not because writing never works at all.
    // The fence runs the script with cwd = scratchDir, so a relative write
    // lands inside the one writable path.
    const result = await runPython(
      [
        'import pathlib',
        'target = pathlib.Path("scratch-probe.txt")',
        'target.write_text("ok")',
        'print(target.read_text())',
      ].join('\n')
    );
    expect(result).toMatchObject({ exitCode: 0, kind: 'completed' });
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    expect(result.stdout.trim()).toBe('ok');
  });

  it('denies a write outside the scratch dir', async () => {
    const forbidden = path.join(
      os.homedir(),
      `brainstrike-run-python-should-not-exist-${Date.now()}`
    );
    const result = await runPython(
      ['import pathlib', `pathlib.Path(${JSON.stringify(forbidden)}).write_text("escaped")`].join(
        '\n'
      )
    );
    // The script fails; the TOOL still completed normally and reports it.
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Permission denied|Read-only|Operation not permitted|OSError/i);
    // The decisive assertion: nothing landed on disk.
    await expect(fsPromises.access(forbidden)).rejects.toThrow();
  });

  it('denies network access, which the tool cannot even be asked to grant', async () => {
    // MUST use urllib, not a raw socket. srt enforces `allowedDomains` at its
    // HTTP proxy, and a raw `socket.create_connection` is refused by the fence
    // regardless of the policy — so a raw-socket assertion passes identically
    // whether allowedDomains is [] or ['example.com'], i.e. it proves nothing
    // about the policy this tool sets. Verified by mutation: with urllib, a
    // temporary allowedDomains: ['example.com'] makes this test FAIL.
    const result = await runPython(
      [
        'import urllib.request',
        'try:',
        `    urllib.request.urlopen("https://${PROBE_HOST}", timeout=15)`,
        '    print("NETWORK-REACHED")',
        'except Exception as error:',
        '    print("NETWORK-BLOCKED", type(error).__name__)',
      ].join('\n')
    );
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    // NETWORK-REACHED would mean egress leaked out of the fence.
    expect(result.stdout).not.toContain('NETWORK-REACHED');
    // Not merely absent: the suite only runs when the host CAN reach this
    // host unsandboxed, so a block here is the fence, not a dead network.
    expect(result.stdout).toContain('NETWORK-BLOCKED');
  });

  it('stops a runaway script at the timeout and reports it as timed_out', async () => {
    const result = await runPython('import time\nwhile True:\n    time.sleep(0.05)', {
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('timed_out');
    if (result.kind !== 'timed_out') {
      throw new Error(`expected timed_out, got ${result.kind}`);
    }
    expect(result.timeoutMs).toBe(2000);
    expect(result.signal).not.toBeNull();
  });

  it('deletes the scratch dir after the call, leaving nothing behind', async () => {
    const result = await runPython(
      ['import os, pathlib', 'print(pathlib.Path(os.getcwd()).resolve())'].join('\n')
    );
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    const reportedCwd = result.stdout.trim();
    expect(reportedCwd.length).toBeGreaterThan(0);
    await expect(fsPromises.access(reportedCwd)).rejects.toThrow();
  });
});
