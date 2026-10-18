/**
 * BST-2073: the standalone CLI host offers `executeCommand` under the default
 * `execute: ask` policy. A trusted `--platform` module scripts the model's one
 * shell call and records every native process the host starts (the host's own
 * `observeNativeChildren` seam), so the denial proof is about spawns, not output.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const platform = pathToFileURL(fileURLToPath(new URL('../dist/platform.js', import.meta.url))).href;
const require = createRequire(import.meta.url);
const scripted = pathToFileURL(
  require.resolve('@brainstrike/agent-host/test-fixtures/scripted-model')
).href;
const nativeChildren = pathToFileURL(
  require.resolve('@brainstrike/state-store/native-children')
).href;
const SHELL_TOOL = 'brainstrike_executeCommand';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

interface ShellInput {
  readonly command: string;
  readonly timeoutMs?: number;
}

/** The standalone platform with one scripted shell call; every started native process is logged. */
async function shellPlatformModule(directory: string, input: ShellInput, spawnLog: string) {
  const module = join(directory, 'shell-platform.mjs');
  await writeFile(
    module,
    `import { appendFileSync } from 'node:fs';
import { createHostPlatform as standalone } from ${JSON.stringify(platform)};
import { scriptedToolSteps } from ${JSON.stringify(scripted)};
import { observeNativeChildren } from ${JSON.stringify(nativeChildren)};
observeNativeChildren({
  exited: () => undefined,
  started: (child) => appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(child) + '\\n'),
});
const fixture = scriptedToolSteps([[{ input: ${JSON.stringify(input)}, toolId: ${JSON.stringify(SHELL_TOOL)} }]]);
const model = {
  doGenerate: (options) => fixture.doGenerate(options),
  doStream: (options) => fixture.doStream(options),
  modelId: 'shell',
  provider: 'shell-fixture',
  specificationVersion: fixture.specificationVersion,
  supportedUrls: fixture.supportedUrls,
};
export const createHostPlatform = (options, startup, launch) =>
  standalone(options, startup, launch, { models: [{ budgets: 'openai::gpt-6-luna', model }] });
`
  );
  return module;
}

/** `shellInput` receives the spawn log's path, so the command can wait for its own record. */
async function shellHost(shellInput: (spawnLog: string) => ShellInput) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-standalone-shell-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-standalone-shell-ws-')));
  const fixtures = await mkdtemp(join(tmpdir(), 'bs-standalone-shell-module-'));
  const spawnLog = join(fixtures, 'native-children.jsonl');
  await writeFile(spawnLog, '');
  const input = shellInput(spawnLog);
  const cli = (args: readonly string[]) =>
    new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [bin, '--data-root', dataRoot, ...args],
        {
          cwd: tmpdir(),
          env: {
            LC_ALL: 'C',
            PATH: process.env['PATH'],
            SystemRoot: process.env['SystemRoot'],
            TZ: 'UTC',
          },
          timeout: 60_000,
          windowsHide: true,
        },
        (cause, stdout, stderr) => {
          if (!cause) {
            resolve({ code: 0, stderr, stdout });
          } else if (typeof cause.code === 'number') {
            resolve({ code: cause.code, stderr, stdout });
          } else {
            reject(cause);
          }
        }
      );
    });
  cleanup.push(async () => {
    await rm(workspace, { force: true, recursive: true });
    await rm(fixtures, { force: true, recursive: true });
    await removeFixtureRoot(dataRoot);
  });
  cleanup.push(async () => {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      const { pid } = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      );
      expect(await cli(['host', 'stop'])).toMatchObject({ code: 0 });
      await expect.poll(() => processStartTime(pid), { timeout: 30_000 }).toBeNull();
    }
  });
  const module = await shellPlatformModule(fixtures, input, spawnLog);
  expect(
    await cli(['host', 'start', '--workspace', workspace, '--platform', module])
  ).toMatchObject({ code: 0, stderr: '' });
  const rows = async (threadId: string): Promise<readonly HostLogRow[]> => {
    const shown = await cli(['threads', 'show', '--thread', threadId]);
    expect(shown).toMatchObject({ code: 0, stderr: '' });
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(shown.stdout)).rows;
  };
  const spawned = async () =>
    (await readFile(spawnLog, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => z.object({ pid: z.number() }).parse(JSON.parse(line)));
  /** `run --non-interactive` pauses at the shell approval; the CLI answers it, then attaches. */
  const decide = async (decision: 'approve' | 'deny') => {
    const paused = await cli([
      'run',
      'Run the shell command.',
      '--model',
      'shell-fixture::shell',
      '--json',
      '--non-interactive',
    ]);
    // `execute: ask` holds the command for approval: exit 2, nothing spawned yet.
    expect(paused.code, paused.stderr).toBe(2);
    const { runId, threadId } = z
      .object({ runId: z.string(), threadId: z.string() })
      .parse(JSON.parse(paused.stdout.split('\n')[0] ?? ''));
    const pausedRows = await rows(threadId);
    const requested = pausedRows.find((row) => row.event.type === 'interaction.requested')?.event;
    if (requested?.type !== 'interaction.requested') {
      throw new Error('The standalone shell call did not pause for approval');
    }
    expect(requested).toMatchObject({ input, kind: 'approval', toolId: SHELL_TOOL });
    expect(pausedRows.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
      snapshot: {
        configuration: {
          capabilities: {
            nativeTools: { available: expect.arrayContaining([NATIVE_TOOL_ID.executeCommand]) },
          },
          intent: { permissionPolicy: { policies: { execute: 'ask' }, yolo: false } },
        },
        toolIdentities: { [SHELL_TOOL]: NATIVE_TOOL_ID.executeCommand },
      },
    });
    expect(await spawned()).toEqual([]);
    expect(
      await cli([
        'interaction',
        'respond',
        '--thread',
        threadId,
        '--run',
        runId,
        '--interaction',
        requested.interactionId,
        '--decision',
        decision,
      ])
    ).toMatchObject({ code: 0 });
    const attached = await cli([
      'attach',
      '--thread',
      threadId,
      '--run',
      runId,
      '--json',
      '--non-interactive',
    ]);
    expect(attached, attached.stderr).toMatchObject({ code: 0, stderr: '' });
    const finished = await rows(threadId);
    expect(finished.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
      outcome: 'completed',
    });
    return {
      rows: finished,
      spawned: await spawned(),
      toolCallId: requested.toolCallId,
      workspace,
    };
  };
  return { decide };
}

test('an approved executeCommand runs echo in the launch root and commits its output', {
  timeout: 180_000,
}, async () => {
  // The host supervises a native process only while it is alive: an exited one holds nothing (ADR-0017). On Linux,
  // dash runs a bare `echo` and is already a zombie when the host reads its start time (BST-2151), so this shell
  // echoes its pid only once the observer has recorded it. The tool's own timeout bounds a record that never comes.
  const host = await shellHost((spawnLog) => ({
    command: `until [ -s '${spawnLog}' ]; do sleep 0.01; done; echo standalone-shell-ok $$`,
    timeoutMs: 30_000,
  }));
  const { rows, spawned, toolCallId, workspace } = await host.decide('approve');
  expect(rows.find((row) => row.event.type === 'effect.started')?.event).toMatchObject({
    toolCallId,
    toolId: SHELL_TOOL,
  });
  const finished = rows.find(
    (row) => row.event.type === 'effect.finished' && row.event.toolCallId === toolCallId
  )?.event;
  expect(finished).toMatchObject({
    output: {
      cwd: workspace,
      exitCode: 0,
      rootId: workspace,
      signal: null,
      stdout: expect.stringMatching(/^standalone-shell-ok \d+\n$/u),
      timedOut: false,
    },
  });
  // The shell itself is a native process the host started under its Root.
  const { output } = z.object({ output: z.object({ stdout: z.string() }) }).parse(finished);
  expect(spawned).toContainEqual({ pid: Number(output.stdout.split(' ')[1]) });
});

test('a denied executeCommand never spawns its process', { timeout: 180_000 }, async () => {
  const marker = 'denied-marker.txt';
  const host = await shellHost(() => ({ command: `echo should-not-run > ${marker}` }));
  const { rows, spawned, toolCallId, workspace } = await host.decide('deny');
  expect(spawned).toEqual([]);
  expect(existsSync(join(workspace, marker))).toBe(false);
  expect(
    rows.filter(
      (row) =>
        (row.event.type === 'effect.started' || row.event.type === 'effect.finished') &&
        row.event.toolCallId === toolCallId
    )
  ).toEqual([]);
});
