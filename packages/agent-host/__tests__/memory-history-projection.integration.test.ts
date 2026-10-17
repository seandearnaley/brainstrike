import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import hookBlocked from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json' with {
  type: 'json',
};
import hooksSkipped from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json' with {
  type: 'json',
};
import mcpUnavailable from '@brainstrike/test-utils/fixtures/committed-host-mcp-unavailable.json' with {
  type: 'json',
};
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import question from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import rewinds from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json' with {
  type: 'json',
};
import attempts from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json' with {
  type: 'json',
};
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import type { MastraDBMessage } from '@mastra/core/agent';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { StateStoreMemoryStorage } from '../src/adapters/memory-storage.js';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from '../src/adapters/state-store-host-memory.js';
import { HostCore } from '../src/core.js';
import { hydratesHostEvent, readHostRow, storedHostEvent } from '../src/event-storage.js';
import type { HostPlatform, HostRunContext } from '../src/ports.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const RESOURCE_ID = 'brainstrike:workspace';
const recordings = [
  approved,
  granted,
  hookBlocked,
  hooksSkipped,
  mcpUnavailable,
  plan,
  question,
  rewinds,
  attempts,
  rich,
];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const native: StateStoreHostMemoryOptions['native'] = {
  options: {
    lastMessages: 10,
    observationalMemory: false,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource' },
  },
};

/** The rows a run's Memory read before the projection: a whole-store scan, re-decoded. */
async function storeDecodedRows(
  store: StateStore,
  threadIds: ReadonlySet<string>
): Promise<HostLogRow[]> {
  return Promise.all(
    (await store.readAll())
      .filter((row) => threadIds.has(row.threadId))
      .map((row) => readHostRow(store, row))
  );
}

/**
 * Core's projection holds exactly the store's decoded rows that hydration keeps,
 * and the Memory transcript built from it equals the one built from every row.
 */
async function expectProjectionMatchesStore(
  store: StateStore,
  context: HostRunContext
): Promise<number> {
  const threadIds = new Set((await store.readAll()).map((row) => row.threadId));
  for (const scope of [threadIds, ...[...threadIds].map((threadId) => new Set([threadId]))]) {
    const projected = context.readCommittedRows(scope);
    const decoded = await storeDecodedRows(store, scope);
    expect(projected).toEqual(decoded.filter((row) => hydratesHostEvent(row.event)));
    expect(committedMemoryTranscript(projected, RESOURCE_ID)).toEqual(
      committedMemoryTranscript(decoded, RESOURCE_ID)
    );
  }
  return committedMemoryTranscript(context.readCommittedRows(threadIds), RESOURCE_ID).length;
}

async function openCore(
  store: StateStore
): Promise<{ core: HostCore; contexts: HostRunContext[] }> {
  const model = scriptedModel();
  const contexts: HostRunContext[] = [];
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
      provider: { prepare: async ({ messages }) => ({ messages: [...messages], model }) },
      snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    maxSteps: 3,
    openRun: (context) => {
      contexts.push(context);
      return StateStoreHostMemory.open(context, {
        native,
        providerRequestContext: () => ({ inputTokenLimit: 200_000, provider: 'openai' }),
        recordPrompt: async () => undefined,
        resourceId: RESOURCE_ID,
        store,
      });
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
  return { contexts, core: await HostCore.open(store, platform, () => () => undefined) };
}

async function runToFinish(core: HostCore, threadId: string, prompt: string): Promise<void> {
  const finished = async (): Promise<number> =>
    (await core.read(threadId, 0)).filter((row) => row.event.type === 'run.finished').length;
  const before = await finished();
  await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt, threadId });
  await expect.poll(finished, { timeout: 30_000 }).toBe(before + 1);
}

test("a run's projected history equals the store's decoded rows, at commit and after hydration", async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-projection-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  cleanup.push(async () => {
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  // Recorded runtime rows reach Core through hydration.
  for (const recording of recordings) {
    const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })(recording);
    await store.append(rows.map((row) => storedHostEvent(row.threadId, row.event)));
  }

  const first = await openCore(store);
  const seeded: string[] = [];
  for (let thread = 0; thread < 3; thread += 1) {
    const { threadId } = await first.core.startThread({ commandId: randomUUID() });
    seeded.push(threadId);
    for (let turn = 1; turn <= 2; turn += 1) {
      await runToFinish(first.core, threadId, `Seeded thread ${thread}, turn ${turn}.`);
    }
  }
  const committedContext = first.contexts.at(-1);
  if (!committedContext) {
    throw new Error('A seeded run opened no Memory owner');
  }
  // Recorded rows came through hydration; seeded runs' rows came through commit.
  const atCommit = await expectProjectionMatchesStore(store, committedContext);
  expect(atCommit).toBeGreaterThan(0);
  await first.core.close();

  // Every row, the seeded runs' included, now reaches a new Core through hydration.
  const second = await openCore(store);
  cleanup.push(() => second.core.close());
  await runToFinish(second.core, seeded[0] ?? '', 'After reopening.');
  const hydratedContext = second.contexts.at(-1);
  if (!hydratedContext) {
    throw new Error('The reopened run opened no Memory owner');
  }
  expect(await expectProjectionMatchesStore(store, hydratedContext)).toBeGreaterThan(atCommit);

  // Memory's thread-scoped queries answer from their threads' transcript
  // exactly what they answered from the whole resource's transcript.
  const allThreads = new Set((await store.readAll()).map((row) => row.threadId));
  const transcript = (threadIds?: ReadonlySet<string>): Promise<MastraDBMessage[]> =>
    Promise.resolve(
      committedMemoryTranscript(
        hydratedContext.readCommittedRows(threadIds ?? allThreads),
        RESOURCE_ID
      )
    );
  const scoped = new StateStoreMemoryStorage(RESOURCE_ID, store, { read: transcript });
  const whole = new StateStoreMemoryStorage(RESOURCE_ID, store, { read: () => transcript() });
  cleanup.push(async () => {
    await scoped.close();
    await whole.close();
  });
  const [own, other] = seeded;
  const included = (await transcript(new Set([other ?? '']))).at(-1);
  if (!(own && other && included)) {
    throw new Error('The seeded threads have no committed messages');
  }
  const queries: Parameters<StateStoreMemoryStorage['listMessages']>[0][] = [
    ...seeded.map((threadId) => ({
      includeTotal: false,
      orderBy: { direction: 'DESC' as const, field: 'createdAt' as const },
      perPage: 10,
      resourceId: RESOURCE_ID,
      threadId,
    })),
    { perPage: false, threadId: own },
    { page: 1, perPage: 2, threadId: own },
    {
      include: [{ id: included.id, threadId: other, withPreviousMessages: 1 }],
      perPage: 3,
      threadId: own,
    },
    { include: [{ id: included.id, withNextMessages: 1 }], perPage: 3, threadId: own },
  ];
  for (const query of queries) {
    const answer = await scoped.listMessages(query);
    expect(answer.messages.length).toBeGreaterThan(0);
    expect(answer).toEqual(await whole.listMessages(query));
  }
  const messages = await transcript(new Set([own]));
  expect(await scoped.saveMessages({ messages })).toEqual(await whole.saveMessages({ messages }));
}, 120_000);
