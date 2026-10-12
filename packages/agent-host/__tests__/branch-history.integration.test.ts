/**
 * Committed branch history through the public client and a real host
 * (BST-1929, #3543 6054972701): Edit and Regenerate admit new runs whose model
 * request is the selected path only, survive a restart, keep cancellation,
 * approvals, command dedupe and the one-active-run rule, and never replay an
 * earlier branch's effects.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { committedRunIdentity } from '../src/committed-identities.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
type Prompt = MockLanguageModelV4['doStreamCalls'][number]['prompt'];

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function lastUserText(prompt: Prompt): string {
  const user = prompt.findLast((message) => message.role === 'user');
  return user?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? '';
}

/** The request as `role: text` lines: tool calls and results by name, never by content. */
function transcript(prompt: Prompt): string[] {
  return prompt.flatMap((message) => {
    if (message.role === 'system') {
      return [];
    }
    if (typeof message.content === 'string') {
      return [`${message.role}: ${message.content}`];
    }
    return message.content.map((part) => {
      if (part.type === 'text') {
        return `${message.role}: ${part.text}`;
      }
      return `${message.role}: ${part.type}${'toolName' in part ? ` ${part.toolName}` : ''}`;
    });
  });
}

/**
 * Answers every call with a distinct `answer N`, so sibling content is
 * detectable in a request. For `tool` it first calls write_file; for `block`
 * it streams until its run is stopped.
 */
function branchModel(options: { readonly block?: string; readonly tool?: string } = {}) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal, prompt }) => {
      const call = calls;
      calls += 1;
      const user = lastUserText(prompt);
      const latestUser = prompt.findLastIndex((message) => message.role === 'user');
      const answered = prompt.slice(latestUser).some((message) => message.role === 'tool');
      if (user === options.block) {
        return {
          stream: new ReadableStream<Chunk>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
                once: true,
              });
            },
          }),
        };
      }
      const chunks: Chunk[] =
        user === options.tool && !answered
          ? [
              { type: 'stream-start', warnings: [] },
              {
                input: JSON.stringify({ text: `written by call ${call}` }),
                toolCallId: `branch-call-${call}`,
                toolName: 'write_file',
                type: 'tool-call',
              },
              { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { id: 'text-1', type: 'text-start' },
              { delta: `answer ${call}`, id: 'text-1', type: 'text-delta' },
              { id: 'text-1', type: 'text-end' },
              { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
            ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

async function setup(options: { readonly block?: string; readonly tool?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-branch-history-'));
  roots.push(root);
  const model = branchModel(options);
  const writes: string[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      write_file: {
        description: 'Write an owned fixture file',
        execute: async (input) => {
          const { text } = z.object({ text: z.string() }).parse(input);
          writes.push(text);
          await writeFile(join(root, 'permitted.txt'), text);
          return { written: text };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
  };
  let host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  let client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const harness = {
    client: () => client,
    model,
    /** Close the host and start it again over the same root, as a restart does. */
    restart: async () => {
      await client.close();
      await host.close();
      host = await startAgentHost({ lifetime: 'persistent', root }, platform);
      hosts.push(host);
      client = await attachAgentHost(host.record);
      clients.push(client);
    },
    root,
    threadId,
    writes,
  };
  return harness;
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function rowsUntil(
  harness: Harness,
  done: (row: HostLogRow) => boolean
): Promise<HostLogRow[]> {
  let rows: HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (
        await harness.client().request('thread/read', { fromSeq: 0, threadId: harness.threadId })
      ).rows;
      return rows.some(done);
    })
    .toBe(true);
  return rows;
}

const finished = (runId: string) => (row: HostLogRow) =>
  row.event.type === 'run.finished' && row.event.runId === runId;

async function start(harness: Harness, prompt: string, parentMessageId?: string | null) {
  const { runId } = await harness.client().request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    prompt,
    threadId: harness.threadId,
  });
  return runId;
}

async function regenerate(harness: Harness, userMessageId: string) {
  const { runId } = await harness.client().request('run/regenerate', {
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId: harness.threadId,
    userMessageId,
  });
  return runId;
}

/** Each turn's request to the model, keyed by the user text it ends with. */
async function settle(harness: Harness, runId: string) {
  const rows = await rowsUntil(harness, finished(runId));
  return { identity: committedRunIdentity(rows, runId), rows };
}

test('a regenerated, an edited and a branch-continued run each send exactly their selected path', async () => {
  const harness = await setup();
  const first = await start(harness, 'First');
  await settle(harness, first);
  const second = await start(harness, 'Second');
  const { identity: secondIdentity } = await settle(harness, second);
  expect(secondIdentity.parentMessageId).toBe(first);

  const regenerated = await regenerate(harness, secondIdentity.userMessageId);
  const { identity: regeneratedIdentity } = await settle(harness, regenerated);
  expect(regeneratedIdentity).toMatchObject({
    parentMessageId: first,
    userMessageId: secondIdentity.userMessageId,
  });
  const regenerateRequest = harness.model.doStreamCalls[2]?.prompt ?? [];
  expect(transcript(regenerateRequest)).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Second',
  ]);
  expect(JSON.stringify(regenerateRequest)).not.toContain('answer 1');

  const edited = await start(harness, 'Second, edited', first);
  const { identity: editedIdentity } = await settle(harness, edited);
  expect(editedIdentity.parentMessageId).toBe(first);
  const editRequest = harness.model.doStreamCalls[3]?.prompt ?? [];
  expect(transcript(editRequest)).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Second, edited',
  ]);
  for (const sibling of ['"Second"', 'answer 1', 'answer 2']) {
    expect(JSON.stringify(editRequest)).not.toContain(sibling);
  }

  // A send from the regenerated branch continues it, not the newest run.
  const continued = await start(harness, 'Third', regenerated);
  await settle(harness, continued);
  const continueRequest = harness.model.doStreamCalls[4]?.prompt ?? [];
  expect(transcript(continueRequest)).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Second',
    'assistant: answer 2',
    'user: Third',
  ]);
  for (const sibling of ['answer 1', 'Second, edited', 'answer 3']) {
    expect(JSON.stringify(continueRequest)).not.toContain(sibling);
  }
});

test('restart replays the committed branches: identities are unchanged and a resumed branch sends its path', async () => {
  const harness = await setup();
  const first = await start(harness, 'First');
  await settle(harness, first);
  const second = await start(harness, 'Second');
  const { identity: secondIdentity } = await settle(harness, second);
  const regenerated = await regenerate(harness, secondIdentity.userMessageId);
  await settle(harness, regenerated);
  const edited = await start(harness, 'Second, edited', first);
  const { rows: before } = await settle(harness, edited);
  const identitiesBefore = [first, second, regenerated, edited].map((runId) =>
    committedRunIdentity(before, runId)
  );

  await harness.restart();
  const after = (
    await harness.client().request('thread/read', { fromSeq: 0, threadId: harness.threadId })
  ).rows;
  expect(after).toEqual(before);
  expect(
    [first, second, regenerated, edited].map((runId) => committedRunIdentity(after, runId))
  ).toEqual(identitiesBefore);

  // Each branch tip resumes with exactly the path Core folded at restart.
  const fromRegenerated = await start(harness, 'After restart', regenerated);
  await settle(harness, fromRegenerated);
  expect(transcript(harness.model.doStreamCalls.at(-1)?.prompt ?? [])).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Second',
    'assistant: answer 2',
    'user: After restart',
  ]);
  const fromEdited = await start(harness, 'Edited branch after restart', edited);
  await settle(harness, fromEdited);
  expect(transcript(harness.model.doStreamCalls.at(-1)?.prompt ?? [])).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Second, edited',
    'assistant: answer 3',
    'user: Edited branch after restart',
  ]);
});

test('an approval pending inside an edited branch resumes across a restart with that branch only, and its effect runs once', async () => {
  const harness = await setup({ tool: 'Use the tool' });
  const first = await start(harness, 'First');
  await settle(harness, first);
  const second = await start(harness, 'Second');
  await settle(harness, second);
  const branched = await start(harness, 'Use the tool', first);
  const paused = (
    await rowsUntil(harness, (row) => row.event.type === 'interaction.requested')
  ).find((row) => row.event.type === 'interaction.requested')?.event;
  if (paused?.type !== 'interaction.requested') {
    throw new Error('The edited branch did not pause for approval');
  }
  // A second start, or a regenerate, is refused while that run is active.
  await expect(start(harness, 'Too early')).rejects.toThrow(/active root run/);
  await expect(
    regenerate(
      harness,
      committedRunIdentity(await rowsUntil(harness, () => true), second).userMessageId
    )
  ).rejects.toThrow(/active root run/);

  await harness.restart();
  await harness.client().request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: paused.interactionId,
    runId: branched,
    threadId: harness.threadId,
  });
  const { rows } = await settle(harness, branched);
  expect(harness.writes).toEqual(['written by call 2']);
  expect(await readFile(join(harness.root, 'permitted.txt'), 'utf8')).toBe('written by call 2');
  expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
  // The resumed request continues the edited branch: First, then the tool turn.
  const resumed = transcript(harness.model.doStreamCalls.at(-1)?.prompt ?? []);
  expect(resumed.slice(0, 3)).toEqual(['user: First', 'assistant: answer 0', 'user: Use the tool']);
  expect(resumed).not.toContain('user: Second');
  expect(resumed).not.toContain('assistant: answer 1');
});

test('regenerating a turn whose effect already ran never executes that effect again', async () => {
  const harness = await setup({ tool: 'Use the tool' });
  const original = await start(harness, 'Use the tool');
  const paused = (
    await rowsUntil(harness, (row) => row.event.type === 'interaction.requested')
  ).find((row) => row.event.type === 'interaction.requested')?.event;
  if (paused?.type !== 'interaction.requested') {
    throw new Error('The original turn did not pause for approval');
  }
  await harness.client().request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: paused.interactionId,
    runId: original,
    threadId: harness.threadId,
  });
  const { identity, rows: before } = await settle(harness, original);
  expect(harness.writes).toEqual(['written by call 0']);
  const originalRows = before.filter((row) => 'runId' in row.event && row.event.runId === original);

  const regenerated = await regenerate(harness, identity.userMessageId);
  // The regenerated turn asks the model afresh; this model calls the tool for
  // the same prompt, so the new run pauses on its own new approval.
  const rows = await rowsUntil(
    harness,
    (row) => row.event.type === 'interaction.requested' && row.event.runId === regenerated
  );
  expect(harness.writes).toEqual(['written by call 0']);
  expect(rows.filter((row) => 'runId' in row.event && row.event.runId === original)).toEqual(
    originalRows
  );
  const effects = rows.filter((row) => row.event.type === 'effect.started');
  expect(effects).toHaveLength(1);
  expect(effects[0]?.event).toMatchObject({ runId: original });
  // The fresh request never carries the original call or its result.
  const request = JSON.stringify(harness.model.doStreamCalls.at(-1)?.prompt ?? []);
  expect(request).not.toContain('branch-call-0');
  expect(request).not.toContain('written by call 0');
  await harness.client().request('run/stop', {
    commandId: randomUUID(),
    runId: regenerated,
    threadId: harness.threadId,
  });
  await settle(harness, regenerated);
  expect(harness.writes).toEqual(['written by call 0']);
});

test('Stop during a regenerate ends that run alone; its committed branch stays, and the thread continues from its parent', async () => {
  const harness = await setup({ block: 'Second' });
  const first = await start(harness, 'First');
  await settle(harness, first);
  const second = await start(harness, 'Second');
  // The original Second also blocks: stop it, then regenerate it.
  await expect.poll(() => harness.model.doStreamCalls.length).toBe(2);
  await harness.client().request('run/stop', {
    commandId: randomUUID(),
    runId: second,
    threadId: harness.threadId,
  });
  const { identity } = await settle(harness, second);
  const regenerated = await regenerate(harness, identity.userMessageId);
  await expect.poll(() => harness.model.doStreamCalls.length).toBe(3);
  expect(
    await harness.client().request('run/stop', {
      commandId: randomUUID(),
      runId: regenerated,
      threadId: harness.threadId,
    })
  ).toEqual({ outcome: 'stopped' });
  const { rows } = await settle(harness, regenerated);
  expect(rows.find(finished(regenerated))?.event).toMatchObject({ outcome: 'stopped' });
  expect(committedRunIdentity(rows, regenerated)).toMatchObject({
    parentMessageId: first,
    userMessageId: identity.userMessageId,
  });
  const next = await start(harness, 'Next', first);
  await settle(harness, next);
  expect(transcript(harness.model.doStreamCalls.at(-1)?.prompt ?? [])).toEqual([
    'user: First',
    'assistant: answer 0',
    'user: Next',
  ]);
});

test('a repeated command ID is one admission, a reused ID with other input is refused, and invalid branch points are refused', async () => {
  const harness = await setup();
  const first = await start(harness, 'First');
  const { identity } = await settle(harness, first);
  const command = {
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId: harness.threadId,
    userMessageId: identity.userMessageId,
  };
  const once = await harness.client().request('run/regenerate', command);
  expect(await harness.client().request('run/regenerate', command)).toEqual(once);
  const { rows } = await settle(harness, once.runId);
  expect(rows.filter((row) => row.event.type === 'run.started')).toHaveLength(2);
  await expect(
    harness.client().request('run/regenerate', { ...command, modelId: 'other' })
  ).rejects.toThrow(/reused with different input/);
  await expect(start(harness, 'Orphan', randomUUID())).rejects.toThrow(
    /Branch parent is not a committed run/
  );
  await expect(start(harness, 'Not a run', identity.userMessageId)).rejects.toThrow(
    /Branch parent is not a committed run/
  );
  await expect(regenerate(harness, first)).rejects.toThrow(/no committed user message/);
  await expect(regenerate(harness, randomUUID())).rejects.toThrow(/no committed user message/);
  // Nothing was admitted by the refused commands.
  const after = (
    await harness.client().request('thread/read', { fromSeq: 0, threadId: harness.threadId })
  ).rows;
  expect(after.filter((row) => row.event.type === 'run.started')).toHaveLength(2);
});
