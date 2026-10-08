import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAskUserTool, createSubmitPlanTool } from '@brainstrike/agent';
import type { RuntimeData } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { processStartTime, RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import {
  canonicalToolInputSchema,
  canonicalToolModelOutput,
  createCanonicalToolContext,
} from '../src/adapters/canonical-context.js';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostTool } from '../src/ports.js';
import { loadHostPlatform } from '../src/process-entry.js';
import {
  HOST_RESULT_SCHEMAS,
  type HostEvent,
  type HostLogRow,
  HostLogRowSchema,
} from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';

const cli = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const platform = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const childPids: number[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const host of hosts.splice(0)) {
    await host.close();
  }
  for (const pid of childPids.splice(0)) {
    expect(processStartTime(pid)).toBeNull();
  }
  for (const root of roots.splice(0)) {
    await removeFixtureRoot(root);
  }
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-cli-control-'));
  roots.push(value);
  return value;
}

function command(
  dataRoot: string,
  name: 'status' | 'stop'
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return cliCommand(dataRoot, ['--platform', platform, 'host', name]);
}

function windowsBatchArguments(executable: string, args: readonly string[]): string[] {
  // Preserve argv through the installed pnpm .cmd and its second CMD parse:
  // https://github.com/moxystudio/node-cross-spawn/blob/v7.0.6/lib/parse.js
  const escapeMeta = (value: string) => value.replace(/[()[\]%!^"`<>&|;, *?]/g, '^$&');
  const quoted = args.map((value) => {
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
    return escapeMeta(escapeMeta(`"${escaped}"`));
  });
  return ['/d', '/s', '/c', `"${escapeMeta(executable)} ${quoted.join(' ')}"`];
}

function cliCommand(
  dataRoot: string,
  args: readonly string[],
  alias: 'tracked' | 'brainstrike' | 'brainstrike-host' = 'tracked'
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const values = ['--data-root', dataRoot, ...args];
  const installed = fileURLToPath(
    new URL(`../../../apps/desktop/node_modules/.bin/${alias}`, import.meta.url)
  );
  const invocation =
    alias === 'tracked'
      ? { args: [cli, ...values], executable: process.execPath, windowsVerbatimArguments: false }
      : process.platform === 'win32'
        ? {
            args: windowsBatchArguments(`${installed}.cmd`, values),
            executable: process.env['ComSpec'] ?? 'cmd.exe',
            windowsVerbatimArguments: true,
          }
        : { args: values, executable: installed, windowsVerbatimArguments: false };
  return new Promise((resolve, reject) => {
    execFile(
      invocation.executable,
      invocation.args,
      {
        env: {
          BRAINSTRIKE_M3_TEST_TOOL: 'fail',
          LC_ALL: 'C',
          PATH: process.env['PATH'],
          PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE:
            process.env['PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE'],
          PNPM_CONFIG_STORE_DIR: process.env['PNPM_CONFIG_STORE_DIR'],
          pnpm_config_enable_global_virtual_store:
            process.env['pnpm_config_enable_global_virtual_store'],
          pnpm_config_store_dir: process.env['pnpm_config_store_dir'],
          pnpm_config_verify_deps_before_run: 'error',
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
        },
        timeout: 10_000,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
}

async function host(dataRoot: string, child = false): Promise<AgentHost> {
  if (child) {
    vi.stubEnv('BRAINSTRIKE_M3_TEST_TOOL', 'child');
  }
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  try {
    const value = await startAgentHost(options, (context) =>
      loadHostPlatform(platform, options, context)
    );
    hosts.push(value);
    return value;
  } finally {
    vi.unstubAllEnvs();
  }
}

test.each(['status', 'stop'] as const)(
  'cold host %s never starts the supplied platform or acquires the root',
  async (name) => {
    const dataRoot = await root();
    const result = await command(dataRoot, name);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(RootLock.inspect(dataRoot)).toBeNull();
    await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(dataRoot, 'fixture-platform-pids'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);

test('host stop returns only after canonical platform and root cleanup', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot);
  const result = await command(dataRoot, 'stop');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  expect(result.stderr).toBe('');
  // A disconnected socket alone is not joined host shutdown.
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dataRoot, 'fixture-platform-closed'), 'utf8')).toBe(
    `${process.pid}\n`
  );
  await owner.closed;
  const contender = await StateStore.open(dataRoot);
  await contender.close();
});

function canonicalInteractionTool(kind: 'question' | 'plan'): HostTool {
  const id = kind === 'question' ? NATIVE_TOOL_ID.askUser : NATIVE_TOOL_ID.submitPlan;
  const selected: NonNullable<RuntimeData['mastraTools']> = {
    [id]: kind === 'question' ? createAskUserTool() : createSubmitPlanTool(),
  };
  const source = selected[id];
  if (
    !(
      source &&
      'description' in source &&
      typeof source.description === 'string' &&
      source.execute &&
      'inputSchema' in source &&
      source.inputSchema &&
      'resumeSchema' in source &&
      source.resumeSchema
    )
  ) {
    throw new Error('Shipped canonical interaction has no executable schemas');
  }
  const execute = source.execute;
  const project = source.toModelOutput;
  return {
    description: source.description,
    execute: async (input, context) =>
      await execute.call(source, input, createCanonicalToolContext(context, id)),
    identity: id,
    inputSchema: canonicalToolInputSchema(source.inputSchema),
    interaction: { kind, resumeSchema: canonicalToolInputSchema(source.resumeSchema) },
    permissionToolId: id,
    risk: 'read',
    ...(project
      ? {
          toModelOutput: async ({ output, toolCallId }) =>
            canonicalToolModelOutput(await project.call(source, output), toolCallId, id),
        }
      : {}),
  };
}

test.each(
  [
    { kind: 'question' as const, output: { answer: 'Local' }, resumeData: { answer: 'Local' } },
    {
      kind: 'question' as const,
      output: { answer: 'Local, Preview' },
      resumeData: { answer: ['Local', 'Preview'] },
    },
    { kind: 'plan' as const, output: { status: 'approved' }, resumeData: { action: 'approved' } },
    {
      kind: 'plan' as const,
      output: { feedback: 'Inspect the current change first.', status: 'rejected' },
      resumeData: { action: 'rejected', feedback: 'Inspect the current change first.' },
    },
  ].flatMap((fixture) =>
    [false, true].flatMap((restart) =>
      [1, 3].map((maxSteps) => ({
        ...fixture,
        alias:
          maxSteps === 1
            ? ('tracked' as const)
            : restart
              ? ('brainstrike-host' as const)
              : ('brainstrike' as const),
        maxSteps,
        restart,
      }))
    )
  )
)(
  '$alias CLI resumes canonical $kind once (restart=$restart, steps=$maxSteps, response=$resumeData)',
  async (fixture) => {
    const dataRoot = await root();
    const execute = (args: readonly string[]) => cliCommand(dataRoot, args, fixture.alias);
    const recordedRows = HostLogRowSchema.array().parse(
      JSON.parse(
        await readFile(
          new URL(
            import.meta.resolve(
              `@brainstrike/test-utils/fixtures/committed-host-${fixture.kind}.json`
            )
          ),
          'utf8'
        )
      )
    );
    const recordedRequest = recordedRows.find(
      ({ event }) => event.type === 'interaction.requested'
    )?.event;
    if (recordedRequest?.type !== 'interaction.requested') {
      throw new Error('Existing recorded canonical interaction has no request');
    }
    const { input, toolId } = recordedRequest;
    const model = scriptedToolSequence([{ input, toolId }]);
    const canonical = canonicalInteractionTool(fixture.kind);
    const executed = vi.fn(canonical.execute);
    const selected = {
      close: async () => undefined,
      maxSteps: fixture.maxSteps,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: { [toolId]: { ...canonical, execute: executed } },
    };
    let owner = await startAgentHost({ lifetime: 'persistent', root: dataRoot }, selected);
    hosts.push(owner);
    let client = await attachAgentHost(owner.record);
    clients.push(client);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const paused = await execute([
      'run',
      'Use the recorded canonical human interaction.',
      '--thread',
      threadId,
      '--model',
      'scripted',
      '--json',
      '--non-interactive',
    ]);
    expect(paused.code).toBe(2);
    const initialized: string[] = [];
    const observed = paused.stdout
      .trim()
      .split('\n')
      .flatMap((line) => {
        const value: unknown = JSON.parse(line);
        const row = HostLogRowSchema.safeParse(value);
        if (row.success) {
          return [row.data];
        }
        if (!(value && typeof value === 'object' && 'runId' in value)) {
          throw new Error('CLI JSON output has neither a committed row nor a run receipt');
        }
        const { runId } = HOST_RESULT_SCHEMAS['run/start'].parse({ runId: value.runId });
        expect(value).toEqual({ runId, threadId });
        initialized.push(runId);
        return [];
      });
    const requested = observed.find(({ event }) => event.type === 'interaction.requested')?.event;
    expect(requested).toMatchObject({ input, kind: fixture.kind, toolId });
    if (requested?.type !== 'interaction.requested') {
      throw new Error('CLI did not expose the committed canonical interaction');
    }
    expect(initialized).toEqual([requested.runId]);
    expect(observed.some(({ event }) => event.type === 'effect.started')).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
    let rows: readonly HostLogRow[] = [];
    if (fixture.restart) {
      await expect
        .poll(async () => {
          rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
          return rows.some(
            ({ event }) =>
              event.type === 'stream.chunk' &&
              event.chunk !== null &&
              typeof event.chunk === 'object' &&
              !Array.isArray(event.chunk) &&
              event.chunk['type'] === 'finish'
          );
        })
        .toBe(true);
      await client.close();
      await owner.close();
      owner = await startAgentHost({ lifetime: 'persistent', root: dataRoot }, selected);
      hosts.push(owner);
      client = await attachAgentHost(owner.record);
      clients.push(client);
      expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(rows);
    }
    const args = [
      'interaction',
      'resume',
      '--thread',
      threadId,
      '--run',
      requested.runId,
      '--interaction',
      requested.interactionId,
      '--resume-data',
    ];
    for (const invalid of ['{', 'true', '{"unexpected":true}']) {
      const rejected = await execute([...args, invalid]);
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr.length).toBeGreaterThan(0);
    }
    const approval = await execute([
      'interaction',
      'respond',
      '--thread',
      threadId,
      '--run',
      requested.runId,
      '--interaction',
      requested.interactionId,
      '--decision',
      'approve',
    ]);
    expect(approval.code).toBe(1);
    expect(approval.stdout).toBe('');
    rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(rows.some(({ event }) => event.type === 'interaction.responded')).toBe(false);
    expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
    expect(executed).not.toHaveBeenCalled();
    const response = [...args, JSON.stringify(fixture.resumeData), '--command-id', randomUUID()];
    const accepted = await execute(response);
    expect(accepted).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(accepted.stdout)).toEqual({ accepted: true });
    expect(accepted.stderr).toBe('');
    expect(await execute(response)).toEqual(accepted);
    await expect
      .poll(async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.find(({ event }) => event.type === 'run.finished')?.event;
      })
      .toMatchObject({ outcome: 'completed' });
    expect(rows.filter(({ event }) => event.type === 'interaction.responded')).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'interaction.responded')?.event).toMatchObject({
      resumeData: fixture.resumeData,
    });
    expect(rows.filter(({ event }) => event.type === 'effect.started')).toHaveLength(1);
    expect(rows.filter(({ event }) => event.type === 'effect.finished')).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'effect.finished')?.event).toMatchObject({
      output: fixture.output,
    });
    expect(executed).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.objectContaining({
        resumeData: fixture.resumeData,
        runId: requested.runId,
        threadId,
      })
    );
    expect(model.doStreamCalls).toHaveLength(fixture.maxSteps === 1 ? 1 : 2);
    const stale = await execute([...args, JSON.stringify(fixture.resumeData)]);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe('');
  }
);

test('live host status reports the authenticated owner without stopping it', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot);
  const result = await command(dataRoot, 'status');
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const { hostVersion, pid, protocolVersion, start } = owner.record;
  expect(JSON.parse(result.stdout)).toEqual({ hostVersion, pid, protocolVersion, start });
  expect(RootLock.inspect(dataRoot)?.owner).toMatchObject({ pid, start });
  await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  await expect(access(join(dataRoot, 'fixture-platform-closed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('host stop remains pending while its platform join still owns Root', async () => {
  const dataRoot = await root();
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  const owner = await startAgentHost(options, async (context) => {
    const selected = await loadHostPlatform(platform, options, context);
    const close = selected.close?.bind(selected);
    selected.close = async () => {
      entered.resolve();
      await joined.promise;
      await close?.();
    };
    return selected;
  });
  hosts.push(owner);
  let settled = false;
  const stopping = command(dataRoot, 'stop').finally(() => {
    settled = true;
  });
  try {
    await entered.promise;
    await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
    expect(settled).toBe(false);
  } finally {
    joined.resolve();
  }
  const result = await stopping;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  await owner.closed;
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});

test('host stop reports failed platform cleanup without claiming Root release', async () => {
  const dataRoot = await root();
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  const owner = await startAgentHost(options, async (context) => {
    const selected = await loadHostPlatform(platform, options, context);
    selected.close = async () => {
      throw new Error('Owned CLI fixture cleanup failed');
    };
    return selected;
  });
  hosts.push(owner);
  const store = owner.core.store;
  if (!(store instanceof StateStore)) {
    throw new Error('CLI shutdown fixture did not acquire its real SQLite store');
  }
  try {
    const result = await command(dataRoot, 'stop');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/cleanup failed/i);
    await expect(owner.closed).rejects.toThrow();
    await expect(RootLock.acquire(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    // This fixture has no external resources. Preserve the failed production
    // close, then release only the test-owned SQLite store for fixture teardown.
    await store.close();
    hosts.splice(hosts.indexOf(owner), 1);
  }
});

test('host stop joins the existing scripted native tool before reporting success', async () => {
  const dataRoot = await root();
  const owner = await host(dataRoot, true);
  const client = await attachAgentHost(owner.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run the existing owned native child fixture.',
    threadId,
  });
  let requested: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
  await expect
    .poll(async () => {
      requested = (await client.request('thread/read', { fromSeq: 0, threadId })).rows
        .map((row) => row.event)
        .find(
          (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
            event.type === 'interaction.requested' && event.runId === runId
        );
      return requested !== undefined;
    })
    .toBe(true);
  if (!requested) {
    throw new Error('Scripted native tool did not request its committed approval');
  }
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: requested.interactionId,
    runId,
    threadId,
  });
  let childPid: number | undefined;
  await expect
    .poll(async () => {
      try {
        childPid = Number(await readFile(join(dataRoot, 'fixture-child-pid'), 'utf8'));
        return Number.isInteger(childPid) && childPid > 0;
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
          return false;
        }
        throw cause;
      }
    })
    .toBe(true);
  if (childPid === undefined) {
    throw new Error('Owned native child identity was not recorded');
  }
  childPids.push(childPid);
  expect(processStartTime(childPid)).not.toBeNull();
  const result = await command(dataRoot, 'stop');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ outcome: 'stopped', rootReleased: true });
  expect(result.stderr).toBe('');
  expect(processStartTime(childPid)).toBeNull();
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await owner.closed;
});
