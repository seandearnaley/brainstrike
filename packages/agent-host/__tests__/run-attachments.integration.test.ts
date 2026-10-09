/**
 * Image attachments on a host run's user message, through the public client
 * and a real host: committed on run.started, sent to the model as the user
 * message's image parts on this turn and every later turn on the branch, and
 * refused at admission when they break the shared attachment contract.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostImageAttachment, HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

type Prompt = MockLanguageModelV4['doStreamCalls'][number]['prompt'];

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
// A 1x1 PNG, encoded as the composer's FileReader encodes a pasted image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMAGE: HostImageAttachment = {
  data: PNG,
  mediaType: 'image/png',
  name: 'pixel.png',
  type: 'image',
};

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Each user message of a model request as its parts' types (and media types). */
function userParts(prompt: Prompt): string[][] {
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? [
          message.content.map((part) =>
            part.type === 'file' ? `file ${part.mediaType}` : `${part.type} ${part.text}`
          ),
        ]
      : []
  );
}

/** `indexed`: with the derived state index, which thread deletion's blob GC requires. */
async function setup(options: { readonly indexed?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-run-attachments-')));
  roots.push(root);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: `answer ${calls}`, id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ],
          initialDelayInMs: null,
        }),
      };
    },
  });
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
  const start = (): Promise<AgentHost> =>
    options.indexed
      ? startAgentHost({ lifetime: 'persistent', root }, async (context) => {
          const native = await openIndexer(
            {
              dbPath: join(root, 'index.sqlite'),
              embedding: { indexMode: 'text-only' },
              rootIds: [root],
              stateProjection: {
                mode: 'dev',
                module: new URL('../dist/state-projection.js', import.meta.url).href,
              },
              stateRoot: root,
            },
            { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
          );
          await context.register(async () => native.close());
          return { ...platform, stateIndexer: createStateStoreIndexer(native) };
        })
      : startAgentHost({ lifetime: 'persistent', root }, platform);
  let host = await start();
  hosts.push(host);
  let client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  return {
    client: () => client,
    model,
    restart: async () => {
      await client.close();
      await host.close();
      host = await start();
      hosts.push(host);
      client = await attachAgentHost(host.record);
      clients.push(client);
    },
    root,
    threadId,
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function settle(harness: Harness, runId: string): Promise<HostLogRow[]> {
  let rows: HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (
        await harness.client().request('thread/read', { fromSeq: 0, threadId: harness.threadId })
      ).rows;
      return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
    })
    .toBe(true);
  return rows;
}

function start(harness: Harness, prompt: string, attachments?: HostImageAttachment[]) {
  return harness.client().request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    ...(attachments ? { attachments } : {}),
    prompt,
    threadId: harness.threadId,
  });
}

test('an attached image is committed with its user message and stays on the branch it starts', async () => {
  const harness = await setup();
  const { runId: first } = await start(harness, 'What is in this image?', [IMAGE]);
  const rows = await settle(harness, first);
  const started = rows.find((row) => row.event.type === 'run.started')?.event;
  expect(started).toMatchObject({ attachments: [IMAGE], prompt: 'What is in this image?' });
  expect(userParts(harness.model.doStreamCalls[0]?.prompt ?? [])).toEqual([
    ['text What is in this image?', 'file image/png'],
  ]);

  // A later turn, after a restart, still sends the committed image on its path.
  await harness.restart();
  const { runId: second } = await start(harness, 'And again?');
  await settle(harness, second);
  expect(userParts(harness.model.doStreamCalls[1]?.prompt ?? [])).toEqual([
    ['text What is in this image?', 'file image/png'],
    ['text And again?'],
  ]);
});

test('an attachment outside the shared contract is refused before any run starts', async () => {
  const harness = await setup();
  await expect(
    start(harness, 'Describe it', [{ ...IMAGE, mediaType: 'image/jpeg' }])
  ).rejects.toThrow(/does not match declared media type/);
  const { rows } = await harness
    .client()
    .request('thread/read', { fromSeq: 0, threadId: harness.threadId });
  expect(rows.some((row) => row.event.type === 'run.started')).toBe(false);
  expect(harness.model.doStreamCalls).toHaveLength(0);
});

/** Files under the host's data root whose bytes contain `needle`, relative to the root. */
async function filesContaining(root: string, needle: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) {
      matches.push(path.slice(root.length + 1));
    }
  }
  return matches.sort();
}

test('an attached image is stored once, in one blob, and thread deletion drops it', async () => {
  const harness = await setup({ indexed: true });
  // Large enough that its run.started spools to a blob (>= 12 KB), as a real photo does.
  const bytes = Buffer.concat([
    Buffer.from(PNG.split(',')[1] ?? '', 'base64'),
    Buffer.alloc(16_384, 7),
  ]);
  const base64 = bytes.toString('base64');
  const image: HostImageAttachment = {
    data: `data:image/png;base64,${base64}`,
    mediaType: 'image/png',
    name: 'photo.png',
    type: 'image',
  };
  const { runId } = await start(harness, 'Describe the photo.', [image]);
  const rows = await settle(harness, runId);
  // The command record names the image by digest; its bytes are the run's.
  const accepted = rows.find(
    (row) => row.event.type === 'command.accepted' && row.event.method === 'run/start'
  )?.event;
  expect(JSON.stringify(accepted)).not.toContain(base64);
  expect(accepted).toMatchObject({
    payload: { attachments: [{ mediaType: 'image/png', name: 'photo.png', type: 'image' }] },
  });
  const stored = await filesContaining(harness.root, base64);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatch(/^blobs\//);

  await harness.client().request('thread/delete', { threadId: harness.threadId });
  await expect.poll(() => filesContaining(harness.root, base64)).toEqual([]);
});

test('a repeated start command is recognised by its images, and different images are refused', async () => {
  const harness = await setup();
  const commandId = randomUUID();
  const params = {
    attachments: [IMAGE],
    commandId,
    modelId: 'scripted',
    prompt: 'Describe it',
    threadId: harness.threadId,
  };
  const first = await harness.client().request('run/start', params);
  await settle(harness, first.runId);
  expect(await harness.client().request('run/start', params)).toEqual(first);
  await expect(
    harness.client().request('run/start', {
      ...params,
      attachments: [{ ...IMAGE, data: `${PNG.slice(0, -4)}AAA=` }],
    })
  ).rejects.toThrow(/Command identity was reused with different input/);
});

/**
 * BST-1932 (AT-09): the composer sends an image with no text, as the legacy
 * assistant accepted it. The model reads the image alone, never an empty text.
 */
test('an image sent without text is a user message of its image alone', async () => {
  const harness = await setup();
  const { runId } = await start(harness, '', [IMAGE]);
  const rows = await settle(harness, runId);
  expect(rows.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
    attachments: [IMAGE],
    prompt: '',
  });
  expect(userParts(harness.model.doStreamCalls[0]?.prompt ?? [])).toEqual([['file image/png']]);
});

test('a message with neither text nor an image is refused, with nothing committed', async () => {
  const harness = await setup();
  await expect(start(harness, '')).rejects.toThrow();
  const { rows } = await harness
    .client()
    .request('thread/read', { fromSeq: 0, threadId: harness.threadId });
  expect(rows.some((row) => row.event.type === 'run.started')).toBe(false);
});
