import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// BST-1939: explicit recording from real SDK -> socket -> writer-worker SQLite
// -> replay, in a fresh data root. Four threads, each one run whose read tool
// returns multi-line, tab-separated notes, as a file or shell tool does. Three
// threads are titled through `thread/update`. Scripted model, no live provider.
const scenarios = {
  'scripted-grep': {
    answer:
      'Trigram candidate selection cut regex grep p95 from 412ms to 38ms with identical rows.',
    notes:
      'exhaustive scan\tp95 412ms\ntrigram candidates\tp95 38ms\nresults stayed byte-identical\n',
    prompt: 'Summarize the regex grep benchmark notes.',
    title: 'Grep latency investigation',
  },
  'scripted-kitchen': {
    answer: 'Slate is the cheaper tile quote at $900 before grout and labour.',
    notes: 'porcelain tile\t$1200\nslate tile\t$900\ngrout and labour\t$450\n',
    prompt: 'Compare the tile quotes in my notes.',
    title: 'Kitchen renovation budget',
  },
  'scripted-release': {
    answer: 'The stapler step attaches the notarization ticket after notarytool accepts the build.',
    notes:
      'codesign --deep --options runtime\n\tnotarytool submit --wait\nstapler staple Brainstrike.app\n',
    prompt: 'Read the signing notes and tell me which step staples the ticket.',
    title: 'Release signing checklist',
  },
  'scripted-untitled': {
    answer: 'Notarization failed because the helper binary lacked the hardened runtime.',
    notes: 'notarytool log 7f3a\n\tstatus: Invalid\n\tissue: hardened runtime missing on helper\n',
    prompt: 'Why did notarization fail last night?',
  },
};
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** One read call, then the scenario's answer once its result is in the prompt. */
function scenarioModel(scenario) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const answered = options.prompt.some(
        (message) =>
          message.role === 'tool' && message.content.some((part) => part.type === 'tool-result')
      );
      const chunks = answered
        ? [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: scenario.answer, id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify({ name: 'notes.txt' }),
              toolCallId: 'recorded-call-1',
              toolName: 'read_notes',
              type: 'tool-call',
            },
            { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
          ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

const root = await mkdtemp(join(tmpdir(), 'bs-m6-record-history-'));
let active;
const host = await startAgentHost(
  { lifetime: 'persistent', root },
  {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async (modelId) => {
      active = scenarios[modelId];
      if (!active) {
        throw new Error(`Unknown recorded scenario ${modelId}`);
      }
      return scenarioModel(active);
    },
    tools: {
      read_notes: {
        description: 'Read an owned fixture notes file',
        execute: async (input) => {
          const { name } = z.object({ name: z.string() }).parse(input);
          return { content: active.notes, name };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ name: z.string() }),
        risk: 'read',
      },
    },
  }
);
const client = await attachAgentHost(host.record);
try {
  const rows = [];
  for (const [modelId, scenario] of Object.entries(scenarios)) {
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    if (scenario.title) {
      await client.request('thread/update', {
        commandId: randomUUID(),
        threadId,
        title: scenario.title,
      });
    }
    const finished = Promise.withResolvers();
    const unsubscribe = client.onEvent((row) => {
      if (row.threadId === threadId && row.event.type === 'run.finished') {
        finished.resolve();
      }
    });
    await client.request('log/subscribe', { fromSeq: 0, threadId });
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId,
      prompt: scenario.prompt,
      threadId,
    });
    await finished.promise;
    unsubscribe();
    rows.push(...(await client.request('thread/read', { fromSeq: 0, threadId })).rows);
  }
  await writeFile(
    new URL('./committed-history-search.json', import.meta.url),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
