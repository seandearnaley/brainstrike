/**
 * The `brainstrike.executeCommand` executor's REAL execute: it spawns the
 * native shell, runs a fixture command in a real temp-dir workspace, and
 * streams the subprocess's output live through the writer the host binds for
 * the call.
 *
 * The loop half — that a real loop advertises this tool and dispatches a model
 * call to this execute, with the subprocess's side effect landing on disk — is
 * proven on Desktop's host path by `apps/desktop/src/__tests__/host-live-native-tools.integration.test.ts`
 * and on the standalone CLI by `standalone-production-shell.integration.test.ts`.
 * This file owns the tool's own side of that seam.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeLiveChildProcesses } from '../src/native-tools/index.js';
import { executeCommandTool, singleRootRuntime } from './fixtures/execute-command.js';

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

describe('executeCommand live shell output (real subprocess, real writer)', () => {
  it('streams incremental shell output keyed to the tool call', async () => {
    const root = await makeWorkspace();
    const { execute } = executeCommandTool(singleRootRuntime(root));

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
        toolCallId: 'call-exec-stream-1',
        writer: {
          custom: async (chunk: { type: string }) => {
            written.push(chunk);
          },
        },
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
