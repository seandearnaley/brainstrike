import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { BLOBS_DIR, StateStore } from '@brainstrike/state-store';
import fixture0 from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import fixture1 from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import fixture2 from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json' with {
  type: 'json',
};
import fixture3 from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json' with {
  type: 'json',
};
import fixture4 from '@brainstrike/test-utils/fixtures/committed-host-mcp-unavailable.json' with {
  type: 'json',
};
import fixture5 from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with {
  type: 'json',
};
import fixture6 from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import fixture7 from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json' with {
  type: 'json',
};
import fixture8 from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json' with {
  type: 'json',
};
import fixture9 from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import { HostCore } from '../src/core.js';
import { readHostRow, storedHostEvent } from '../src/event-storage.js';
import type { HostPlatform } from '../src/ports.js';
import { HostLogRowSchema, type HostRunSnapshot } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const blobReads = vi.hoisted(() => ({ count: 0, root: '' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (blobReads.root && String(args[0]).startsWith(blobReads.root)) {
        blobReads.count += 1;
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const RUNS = 6;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  blobReads.root = '';
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/**
 * The desktop's run configuration, recorded shape: the composed system prompt
 * (about 12.5 KB), the child system and the captured intent, identical on
 * every run of the same settings.
 */
function desktopSnapshot(): HostRunSnapshot {
  return {
    configuration: {
      childSystem: 'Delegated persona instructions. '.repeat(55),
      intent: {
        enabledNativeToolIds: Array.from({ length: 36 }, (_, i) => `brainstrike.tool${i}`),
      },
      system: 'Workspace instructions and the composed system prompt. '.repeat(230),
    },
    maxSteps: 8,
    // Admission checks identities against the admitted catalog; this proof admits no tools.
    toolIdentities: {},
  };
}

async function seededRoot(): Promise<{ root: string; threadId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-snapshot-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  const model = scriptedModel();
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
      provider: { prepare: async ({ messages }) => ({ messages: [...messages], model }) },
      snapshot: desktopSnapshot(),
      tools: {},
    }),
    close: async () => undefined,
    maxSteps: 8,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  for (let run = 1; run <= RUNS; run += 1) {
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: `Turn ${run}.`,
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).filter((row) => row.event.type === 'run.finished').length,
        { timeout: 30_000 }
      )
      .toBe(run);
  }
  await core.close();
  await store.close();
  return { root, threadId };
}

test('a committed run.started keeps its repeated run configuration by reference, small and inline', async () => {
  const { root, threadId } = await seededRoot();
  const store = await StateStore.open(root);
  cleanup.push(() => store.close());
  const started = (await store.read(threadId, 1)).filter((row) => row.event.type === 'run.started');
  expect(started).toHaveLength(RUNS);
  for (const row of started) {
    // Not spooled to its own blob, and well under the 12 KB spool threshold.
    expect(row.event).not.toHaveProperty('blob');
    expect(JSON.stringify(row.event).length).toBeLessThan(4096);
  }
  // Every run's snapshot still resolves to exactly the configuration it ran with.
  const core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      maxSteps: 8,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedModel(),
    },
    () => () => undefined
  );
  cleanup.push(() => core.close());
  const resolved = (await core.read(threadId, 0)).flatMap((row) =>
    row.event.type === 'run.started' ? [row.event.snapshot] : []
  );
  expect(resolved).toEqual(new Array(RUNS).fill(desktopSnapshot()));
}, 120_000);

test("opening a thread reads its runs' shared configuration once, however many runs share it", async () => {
  const { root: seeded } = await seededRoot();
  // A copy of the seeded root: this process has never resolved its blobs.
  const root = `${seeded}-reopened`;
  await cp(seeded, root, { recursive: true });
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  cleanup.push(() => store.close());
  blobReads.root = join(root, BLOBS_DIR);
  blobReads.count = 0;
  const core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      maxSteps: 8,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedModel(),
    },
    () => () => undefined
  );
  cleanup.push(() => core.close());
  expect(blobReads.count).toBe(1);
}, 120_000);

test('every recorded run reads back exactly as committed, its snapshot resolved from the reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-snapshot-fixtures-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  cleanup.push(() => store.close());
  const recordings = [
    fixture0,
    fixture1,
    fixture2,
    fixture3,
    fixture4,
    fixture5,
    fixture6,
    fixture7,
    fixture8,
    fixture9,
  ];
  let referenced = 0;
  for (const recording of recordings) {
    const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
      errors: 'all',
      onExcessProperty: 'error',
    })(recording);
    await store.append(rows.map((row) => storedHostEvent(row.threadId, row.event)));
    for (const threadId of new Set(rows.map((row) => row.threadId))) {
      const stored = await store.read(threadId, 1);
      referenced += stored.filter((row) => 'snapshotRef' in row.event).length;
      const read = await Promise.all(stored.map((row) => readHostRow(store, row)));
      expect(read.map((row) => row.event)).toEqual(
        rows.filter((row) => row.threadId === threadId).map((row) => row.event)
      );
    }
  }
  // Every recorded run.started that carries a snapshot is stored by reference.
  expect(referenced).toBe(
    recordings.flat().filter((row) => row.event.type === 'run.started' && 'snapshot' in row.event)
      .length
  );
}, 120_000);
