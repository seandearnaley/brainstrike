import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunHooks } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

/** One provider request, as the model received it. */
type ModelRequest = Parameters<MockLanguageModelV4['doStream']>[0];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/** A run of the scripted model (one read_fixture call, then an answer) under the given hooks. */
async function runWithHooks(hooks: Partial<HostRunHooks>) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-lifecycle-hooks-'));
  const store = await StateStore.open(root);
  const requests: ModelRequest[] = [];
  const scripted = scriptedToolSequence([{ input: { path: 'notes.txt' }, toolId: 'read_fixture' }]);
  const doStream = scripted.doStream.bind(scripted);
  const read = vi.fn(async () => ({ content: 'fixture text' }));
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      hooks: {
        matchesPreToolUse: () => false,
        postToolUse: async () => ({}),
        preToolUse: async () => ({ blocked: false }),
        stop: async () => ({}),
        userPromptSubmit: async () => ({ blocked: false }),
        ...hooks,
      },
      model: Object.assign(scripted, {
        doStream: (options: ModelRequest) => {
          requests.push(options);
          return doStream(options);
        },
      }),
      snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { read_fixture: 'read-1' } },
      tools: {
        read_fixture: {
          description: 'Read a fixture',
          execute: read,
          identity: 'read-1',
          inputSchema: z.object({ path: z.string() }),
          permissionToolId: 'brainstrike.readFixture',
          risk: 'read',
        },
      },
    }),
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Read notes.txt',
    threadId,
  });
  let events: HostEvent[] = [];
  await expect
    .poll(async () => {
      events = (await core.read(threadId, 0)).map((row) => row.event);
      return events.some((event) => event.type === 'run.finished');
    })
    .toBe(true);
  return { events, read, requests, runId };
}

test('a Stop hook sees how the run ended and labels it with its verdict', async () => {
  const stop = vi.fn(async () => ({
    verdict: { detail: 'Graded by the acceptance hook', verdict: 'succeeded' as const },
  }));
  const { events, runId } = await runWithHooks({ stop });
  expect(stop).toHaveBeenCalledWith({
    assistantMessage: 'Host run completed.',
    reason: 'complete',
  });
  const types = events.map((event) => event.type);
  // The label lands before the run's terminal row.
  expect(types.indexOf('run.verdict')).toBe(types.indexOf('run.finished') - 1);
  expect(events.find((event) => event.type === 'run.verdict')).toEqual({
    detail: 'Graded by the acceptance hook',
    runId,
    source: 'hook',
    type: 'run.verdict',
    verdict: 'succeeded',
  });
});

test('a UserPromptSubmit hook that blocks the prompt ends the run before any model call', async () => {
  const userPromptSubmit = vi.fn(async () => ({
    blocked: true as const,
    reason: 'Prompts about notes are disabled',
  }));
  const { events, read, requests } = await runWithHooks({ userPromptSubmit });
  expect(userPromptSubmit).toHaveBeenCalledWith('Read notes.txt');
  expect(requests).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    detail: 'The request was blocked by a hook: Prompts about notes are disabled',
    outcome: 'failed',
  });
});

test('a UserPromptSubmit hook’s context joins the run’s instructions for every step', async () => {
  const { events, requests } = await runWithHooks({
    userPromptSubmit: async () => ({
      additionalContext: 'Repository rule: be brief.',
      blocked: false,
    }),
  });
  expect(events).toContainEqual(
    expect.objectContaining({ context: 'Repository rule: be brief.', type: 'hook.context' })
  );
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.prompt[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(request.prompt[0])).toContain('Repository rule: be brief.');
  }
});

test('a PostToolUse hook’s context reaches the model with that tool’s result', async () => {
  const postToolUse = vi.fn(async () => ({ additionalContext: 'The linter passed.' }));
  const { events, requests } = await runWithHooks({ postToolUse });
  expect(postToolUse).toHaveBeenCalledWith({
    error: false,
    input: { path: 'notes.txt' },
    output: { content: 'fixture text' },
    toolName: 'brainstrike.readFixture',
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      context: 'The linter passed.',
      toolCallId: 'recorded-call-1',
      type: 'hook.context',
    })
  );
  const toolResult = JSON.stringify(requests[1]?.prompt.find((message) => message.role === 'tool'));
  expect(toolResult).toContain('fixture text');
  expect(toolResult).toContain('The linter passed.');
});
