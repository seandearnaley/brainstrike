/**
 * ADR-0040: project memory through the real standalone host and a scripted
 * model. A note one thread saves is in the next thread's instructions in the
 * same project and in no other project's; an untrusted launch root loads
 * none; the index loads to its limit with a marker; a path outside the memory
 * folder is refused.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MemoryInput } from '@brainstrike/assistant-contract/native-tool-schemas';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { ProjectMemoryNotes } from '../src/project-memory/memory-notes.ts';
import {
  drainCleanup,
  recordedToolResults,
  refusingProvider,
  type StandaloneHost,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

const MODEL = 'trusted-fixture::probe';
const NOTE: MemoryInput = {
  command: 'create',
  file_text: "# Test runtime\nThis repo's tests need Node 26.\n",
  path: '/memories/test-runtime.md',
};

/** Records the launch root as a folder with a project, as the desktop's registry does. */
async function recordProject(dataRoot: string, workspace: string): Promise<string> {
  const store = await StateStore.open(dataRoot);
  try {
    const { roots } = await store.workspaceRoots({
      operation: 'register',
      root: {
        canonicalPath: workspace,
        displayName: basename(workspace),
        path: workspace,
        preferredId: randomUUID(),
      },
    });
    const projectId = roots[0]?.projectId;
    if (!projectId) {
      throw new Error('The recorded folder has no project');
    }
    return projectId;
  } finally {
    await store.close();
  }
}

async function trust(host: StandaloneHost): Promise<void> {
  expect(await host.command(['workspace', 'trust', host.workspace, '--yes'])).toMatchObject({
    code: 0,
  });
}

/** The instructions the run started with, as `run.started` committed them. */
function startedConfiguration(rows: Awaited<ReturnType<StandaloneHost['run']>>['rows']) {
  return z
    .object({
      snapshot: z.object({
        configuration: z.object({
          intent: z.object({ enabledNativeToolIds: z.array(z.string()) }),
          system: z.string(),
        }),
      }),
    })
    .parse(
      (rows ?? []).map((row) => row.event).find((event) => event.type === 'run.started'),
      { reportInput: true }
    ).snapshot.configuration;
}

async function stop(host: StandaloneHost): Promise<void> {
  const { pid } = decodeHostRecord(
    JSON.parse(await readFile(join(host.dataRoot, 'host.json'), 'utf8'))
  );
  expect(await host.command(['host', 'stop'])).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(pid), { timeout: 30_000 }).toBeNull();
}

test("a note one thread saves is in the next thread's instructions in its project, and in no other project's", {
  timeout: 180_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: NOTE, toolId: 'brainstrike_memory' },
  ]);
  const first = await standaloneHost({}, module, {}, async ({ dataRoot, workspace }) => {
    await recordProject(dataRoot, workspace);
  });
  expect(first.started, first.started.stderr).toMatchObject({ code: 0 });
  await trust(first);

  const saving = await first.run(MODEL);
  expect(saving.result, saving.result.stderr).toMatchObject({ code: 0 });
  const saved = startedConfiguration(saving.rows);
  expect(saved.intent.enabledNativeToolIds).toContain('brainstrike.memory');
  expect(saved.system).toContain('# Project memory');
  expect(saved.system).toContain('No notes yet.');
  // The write is committed under its call, as the card the thread shows.
  expect((saving.rows ?? []).map((row) => row.event)).toContainEqual(
    expect.objectContaining({
      path: '/memories/test-runtime.md',
      text: NOTE.file_text,
      title: 'Test runtime',
      toolCallId: 'recorded-call-1',
      type: 'memory.changed',
      untrusted: false,
    })
  );

  // The next thread in the same project starts knowing it.
  const next = await first.run(MODEL);
  expect(next.result, next.result.stderr).toMatchObject({ code: 0 });
  expect(startedConfiguration(next.rows).system).toContain(
    "- [Test runtime](test-runtime.md) — This repo's tests need Node 26."
  );

  // Another project in the same data root has its own memory, without the note.
  await stop(first);
  const other = await standaloneHost(
    {},
    module,
    {},
    async ({ dataRoot, workspace }) => {
      await recordProject(dataRoot, workspace);
    },
    { dataRoot: first.dataRoot }
  );
  expect(other.started, other.started.stderr).toMatchObject({ code: 0 });
  await trust(other);
  const elsewhere = await other.run(MODEL);
  expect(elsewhere.result, elsewhere.result.stderr).toMatchObject({ code: 0 });
  const otherSystem = startedConfiguration(elsewhere.rows).system;
  expect(otherSystem).toContain('No notes yet.');
  expect(otherSystem).not.toContain('Test runtime');
});

test("an Anthropic model's run is given the memory function tool with its six commands, and no provider-defined memory tool", {
  timeout: 120_000,
}, async () => {
  const provider = await refusingProvider();
  const host = await standaloneHost(
    { ANTHROPIC_BASE_URL: provider.baseUrl, BRAINSTRIKE_ANTHROPIC_API_KEY: 'memory-fixture-key' },
    undefined,
    {},
    async ({ dataRoot, workspace }) => {
      await recordProject(dataRoot, workspace);
    }
  );
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  await trust(host);

  // The stand-in refuses the request; what the run sent is the point.
  const ran = await host.run('anthropic::claude-opus-5');
  expect(ran.result.code).toBe(1);
  const tools = z
    .array(z.record(z.string(), z.unknown()))
    .parse(provider.requests.find(({ body }) => Array.isArray(body['tools']))?.body['tools']);
  expect(tools.find((tool) => tool['name'] === 'brainstrike_memory')).toMatchObject({
    input_schema: {
      properties: {
        command: { enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] },
      },
    },
  });
  expect(tools.filter((tool) => tool['name'] === 'memory' || 'type' in tool)).toEqual([]);
});

test('an untrusted launch root loads no memory and offers no memory tool', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture');
  const host = await standaloneHost({}, module, {}, async ({ dataRoot, workspace }) => {
    const projectId = await recordProject(dataRoot, workspace);
    const notes = await ProjectMemoryNotes.open(dataRoot, projectId);
    await notes.execute(NOTE, { untrusted: false });
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });

  const ran = await host.run(MODEL);
  expect(ran.result, ran.result.stderr).toMatchObject({ code: 0 });
  const started = startedConfiguration(ran.rows);
  expect(started.system).not.toContain('# Project memory');
  expect(started.system).not.toContain('Test runtime');
  expect(started.intent.enabledNativeToolIds).not.toContain('brainstrike.memory');
});

test('a run loads the first 200 lines of the index, with a marker where it was cut', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture');
  const host = await standaloneHost({}, module, {}, async ({ dataRoot, workspace }) => {
    const notes = await ProjectMemoryNotes.open(dataRoot, await recordProject(dataRoot, workspace));
    for (let at = 1; at <= 205; at += 1) {
      const file = `n${String(at).padStart(3, '0')}.md`;
      await notes.execute(
        { command: 'create', file_text: `# Note ${at}\nfact ${at}\n`, path: `/memories/${file}` },
        { untrusted: false }
      );
    }
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  await trust(host);

  const ran = await host.run(MODEL);
  expect(ran.result, ran.result.stderr).toMatchObject({ code: 0 });
  const { system } = startedConfiguration(ran.rows);
  expect(system).toContain('- [Note 200](n200.md) — fact 200');
  expect(system).not.toContain('Note 201');
  expect(system).toContain(
    '[Index cut: 5 of 205 lines not loaded. view /memories lists every note.]'
  );
});

test('the memory tool refuses a path outside the memory folder', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { command: 'view', path: '/memories/../../state.db' }, toolId: 'brainstrike_memory' },
    {
      input: { command: 'create', file_text: 'escaped', path: '/escaped.md' },
      toolId: 'brainstrike_memory',
    },
  ]);
  const host = await standaloneHost({}, module, {}, async ({ dataRoot, workspace }) => {
    await recordProject(dataRoot, workspace);
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  await trust(host);

  const ran = await host.run(MODEL);
  expect(ran.result, ran.result.stderr).toMatchObject({ code: 0 });
  const results = recordedToolResults(ran.rows).map(({ output }) => JSON.stringify(output));
  expect(results).toHaveLength(2);
  expect(results[0]).toContain('The path /memories/../../state.db is outside /memories.');
  expect(results[1]).toContain('The path /escaped.md is outside /memories.');
  expect(existsSync(join(host.dataRoot, 'escaped.md'))).toBe(false);
  expect((ran.rows ?? []).some(({ event }) => event.type === 'memory.changed')).toBe(false);
});
