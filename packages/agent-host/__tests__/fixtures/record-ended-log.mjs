import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { HostCore } from '../../dist/core.js';

// Explicit recording from the real SDK -> HostCore -> SQLite of runs that end
// early (BST-1982), one thread per way of ending:
//   1. stopped    — Stop while the reply streams text; then Stop while a tool runs.
//   2. closed     — the host closes (the app quits) while the reply streams text.
//   3. closed-tool — the host closes while a tool runs.
//   4. crashed    — the process dies while the reply streams text; the next
//                   host's recovery ends the run.
// The model is scripted; no live provider. The crash stops the old Core's
// writes and boots a fresh Core over the same store, as child-run-host does.
// Usage: node record-ended-log.mjs <output.json>
const output = process.argv[2];
if (!output) {
  throw new Error('Usage: node record-ended-log.mjs <output.json>');
}
const SCRIPTS = {
  'Call the probe, then stop.': [
    { id: 'text-1', type: 'text-start' },
    { delta: 'Checking with the probe.', id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { id: 'call-1', toolName: 'probe', type: 'tool-input-start' },
    { delta: '{"text":"stop"}', id: 'call-1', type: 'tool-input-delta' },
    { id: 'call-1', type: 'tool-input-end' },
    { input: '{"text":"stop"}', toolCallId: 'call-1', toolName: 'probe', type: 'tool-call' },
    {
      finishReason: { raw: 'tool_calls', unified: 'tool-calls' },
      type: 'finish',
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
        outputTokens: { reasoning: 0, text: 1, total: 1 },
      },
    },
  ],
};
SCRIPTS['Call the probe, then quit.'] = SCRIPTS['Call the probe, then stop.'].map((chunk) =>
  chunk.type === 'tool-input-delta'
    ? { ...chunk, delta: '{"text":"quit"}' }
    : chunk.type === 'tool-call'
      ? { ...chunk, input: '{"text":"quit"}' }
      : chunk
);
/** Text streamed before the reply is held until its run ends. */
const PARTIALS = {
  'Write slowly, then crash.': 'Partial reply before the crash.',
  'Write slowly, then quit.': 'Partial reply before the quit.',
  'Write slowly, then stop.': 'Partial reply before the Stop.',
};
function lastUserText(prompt) {
  const user = prompt.findLast((message) => message.role === 'user');
  return (user?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
const model = new MockLanguageModelV4({
  doStream: async ({ abortSignal, prompt }) => {
    const asked = lastUserText(prompt);
    const partial = PARTIALS[asked];
    const chunks = partial
      ? [
          { id: 'text-1', type: 'text-start' },
          { delta: partial, id: 'text-1', type: 'text-delta' },
        ]
      : SCRIPTS[asked];
    if (!chunks) {
      throw new Error(`No script for ${asked}`);
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
            once: true,
          });
          controller.enqueue({ type: 'stream-start', warnings: [] });
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          if (chunks.some((chunk) => chunk.type === 'finish')) {
            controller.close();
          }
        },
      }),
    };
  },
});
const platform = {
  close: async () => undefined,
  maxSteps: 3,
  readPermissionPolicy: () => ({
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
    yolo: false,
  }),
  resolveModel: async () => model,
  tools: {
    probe: {
      description: 'Read-only probe that runs until its run ends',
      execute: (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      identity: 'probe-identity',
      inputSchema: z.object({ text: z.string() }),
      risk: 'read',
    },
  },
};
/** A Core's view of the store; a crashed process's port commits nothing more. */
function port(store) {
  const state = { dead: false };
  state.port = {
    append: async (items, committed, durability) => {
      if (state.dead) {
        throw new Error('process crashed');
      }
      return store.append(items, committed, durability);
    },
    deleteSetting: (key) => store.deleteSetting(key),
    getSetting: (key) => store.getSetting(key),
    holdBlobGc: () => store.holdBlobGc(),
    read: (threadId, fromSeq) => store.read(threadId, fromSeq),
    readHydration: () => store.readHydration(),
    root: store.root,
    setSetting: (key, value) => store.setSetting(key, value),
    syncBoundary: (threadId) => store.syncBoundary(threadId),
  };
  return state;
}
async function poll(read) {
  for (;;) {
    if (await read()) {
      return;
    }
    await sleep(25);
  }
}
const rowsOf = (core, threadId) => core.read(threadId, 0);
const finished = (rows, runId) =>
  rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
const started = (rows, runId) =>
  rows.some((row) => row.event.type === 'effect.started' && row.event.runId === runId);

const root = await mkdtemp(join(tmpdir(), 'bs-m6-record-ended-'));
const store = await StateStore.open(root);
const cores = [];
try {
  const first = port(store);
  const core = await HostCore.open(first.port, platform, () => () => undefined);
  cores.push(core);
  const streamed = new Set();
  core.onTelemetry(({ chunk, runId }) => {
    if (chunk?.type === 'text-delta') {
      streamed.add(runId);
    }
  });
  const start = async (threadId, prompt) =>
    (await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt, threadId })).runId;

  // 1. Stop while text streams, then Stop while a tool runs.
  const stopped = (await core.startThread({ commandId: randomUUID() })).threadId;
  for (const [prompt, ready] of [
    ['Write slowly, then stop.', (_rows, runId) => streamed.has(runId)],
    ['Call the probe, then stop.', started],
  ]) {
    const runId = await start(stopped, prompt);
    await poll(async () => ready(await rowsOf(core, stopped), runId));
    await core.stop({ commandId: randomUUID(), runId, threadId: stopped });
    await poll(async () => finished(await rowsOf(core, stopped), runId));
  }

  // 2 and 3. The host closes while one run streams text and another runs a tool.
  const closed = (await core.startThread({ commandId: randomUUID() })).threadId;
  const closedTool = (await core.startThread({ commandId: randomUUID() })).threadId;
  const writing = await start(closed, 'Write slowly, then quit.');
  const probing = await start(closedTool, 'Call the probe, then quit.');
  await poll(async () => streamed.has(writing) && started(await rowsOf(core, closedTool), probing));
  await core.close();

  // 4. A second process dies mid-reply; a third boots and recovers the run.
  const second = port(store);
  const crashing = await HostCore.open(second.port, platform, () => () => undefined);
  cores.push(crashing);
  crashing.onTelemetry(({ chunk, runId }) => {
    if (chunk?.type === 'text-delta') {
      streamed.add(runId);
    }
  });
  const crashed = (await crashing.startThread({ commandId: randomUUID() })).threadId;
  const crashedRun = (
    await crashing.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write slowly, then crash.',
      threadId: crashed,
    })
  ).runId;
  await poll(() => streamed.has(crashedRun));
  second.dead = true;
  const recovered = await HostCore.open(port(store).port, platform, () => () => undefined);
  cores.push(recovered);

  const rows = [];
  for (const threadId of [stopped, closed, closedTool, crashed]) {
    rows.push(...(await rowsOf(recovered, threadId)));
  }
  await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`);
} finally {
  // The crashed Core cannot commit its teardown; only its joins matter here.
  await Promise.allSettled(cores.map((owned) => owned.close()));
  await store.close();
  await rm(root, { force: true, recursive: true });
}
