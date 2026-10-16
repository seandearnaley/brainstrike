import './_windows-command-fixture';
/**
 * The desktop `brainstrike.executeCommand` tool's REAL execute: it spawns the
 * native shell, runs a fixture command in a real temp-dir workspace, and
 * streams the subprocess's output live through the writer the host binds for
 * the call.
 *
 * Also proves the REGISTRATION invariant: the tool is always in the map, so
 * shell execution is gated by the permission engine rather than by whether the
 * tool was registered at all.
 *
 * The loop half — that a real loop advertises this tool and dispatches a model
 * call to this execute, with the subprocess's side effect landing on disk — is
 * proven once on the production host path by
 * `src/__tests__/host-live-native-tools.integration.test.ts`. The host's
 * delivery of these written slices to the conversation is proven by
 * `src/__tests__/committed-host-live-shell-output.integration.test.ts`. This
 * file owns the tool's own side of that seam.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeLiveChildProcesses } from '../../assistant-server/execute-command-tool';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';

const createdRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-exec-live-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

async function writeCommandFixture(
  root: string,
  source: string,
  windowsCommand: string
): Promise<string> {
  const fixture = path.join(root, 'live-command.cjs');
  await fsPromises.writeFile(fixture, source, 'utf8');
  return process.platform === 'win32' ? windowsCommand : `"${process.execPath}" "${fixture}"`;
}

afterEach(async () => {
  await disposeLiveChildProcesses();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('executeCommand registration', () => {
  // The interim "register only when enforcement is on" gate was removed: the tool
  // is now ALWAYS registered like every other native tool, and the permission
  // engine (enforce-on-by-default → execute:ask) suspends the run for per-call
  // approval before it executes.
  it('is ALWAYS present in the tool map (gated by the permission engine, not registration)', async () => {
    const root = await makeWorkspace();
    const tools = buildHostNativeTools(singleRootRuntime(root));
    expect(tools['brainstrike.executeCommand']).toBeDefined();
  });
});

describe('executeCommand live shell output (real subprocess, real writer)', () => {
  it('streams incremental shell output keyed to the tool call', async () => {
    const root = await makeWorkspace();
    const tools = buildHostNativeTools(singleRootRuntime(root), {
      ids: ['brainstrike.executeCommand'],
    });
    const execute = requireToolExecute(tools, 'brainstrike.executeCommand');

    // A command that emits a distinctive marker to stdout the tool must stream
    // live, before the final result is captured.
    const command = await writeCommandFixture(
      root,
      "process.stdout.write('LIVE_STREAM_MARKER\\n');",
      'echo LIVE_STREAM_MARKER'
    );

    // The plain-object writer shape the host binds for a native tool call
    // (`resolveShellOutputStreamer` in host-capabilities' tool-execute-support).
    const written: { type: string }[] = [];
    const result = await execute(
      { command },
      {
        outputWriter: (chunk: { type: string }) => {
          written.push(chunk);
        },
        toolCallId: 'call-exec-stream-1',
      }
    );

    // The result carried the real subprocess output.
    expect(JSON.stringify(result)).toContain('LIVE_STREAM_MARKER');

    // Writes are fire-and-forget, so join the enqueue microtasks before reading.
    await new Promise((resolve) => setImmediate(resolve));
    const slices = written as unknown as {
      chunk: string;
      stream: string;
      toolCallId: string;
    }[];
    expect(slices.length).toBeGreaterThanOrEqual(1);
    expect(slices.map((part) => part.chunk).join('')).toContain('LIVE_STREAM_MARKER');
    // Keyed to THIS call: a slice with the wrong id lands in another tool's card.
    expect(slices.every((part) => part.toolCallId === 'call-exec-stream-1')).toBe(true);
    expect(slices.every((part) => part.stream === 'stdout')).toBe(true);
  });
});
