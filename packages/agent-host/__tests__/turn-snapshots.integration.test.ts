/**
 * A host run's turn is bracketed by committed workspace snapshots, for its
 * Changes review: the platform snapshots the run's roots at the turn's start,
 * before its prompt hooks or tools, and the same roots at its end, after its
 * Stop hook and in the append that finishes it. A failed capture is committed
 * visibly; the run itself goes on.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission, HostRunHooks } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const START_OID = 'a'.repeat(40);
const END_OID = 'b'.repeat(40);
const ROOT = { rootId: 'root-1', rootPath: '/workspace/project' };

/** One run of the scripted model (one read_fixture call, then an answer). */
async function runWith(options: {
  readonly captureTurnBoundary: NonNullable<HostRunAdmission['captureTurnBoundary']>;
  readonly hooks?: Partial<HostRunHooks>;
}) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-turn-snapshots-'));
  const store = await StateStore.open(root);
  const scripted = scriptedToolSequence([{ input: { path: 'notes.txt' }, toolId: 'read_fixture' }]);
  const platform: HostPlatform = {
    admitRun: async () => ({
      captureTurnBoundary: options.captureTurnBoundary,
      configuration: {},
      ...(options.hooks
        ? {
            hooks: {
              matchesPreToolUse: () => false,
              postToolUse: async () => ({}),
              preToolUse: async () => ({ blocked: false }),
              stop: async () => ({}),
              userPromptSubmit: async () => ({ blocked: false }),
              ...options.hooks,
            },
          }
        : {}),
      model: scripted,
      snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { read_fixture: 'read-1' } },
      tools: {
        read_fixture: {
          description: 'Read a fixture',
          execute: async () => ({ content: 'fixture text' }),
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
  return { events, runId, threadId };
}

test('a run’s turn is bracketed by snapshots: start before its tool, end before run.finished', async () => {
  const captureTurnBoundary = vi.fn(
    async (request: Parameters<NonNullable<HostRunAdmission['captureTurnBoundary']>>[0]) => [
      { ...ROOT, commitOid: request.boundary === 'turn-start' ? START_OID : END_OID },
    ]
  );
  const { events, runId, threadId } = await runWith({
    captureTurnBoundary,
    hooks: {
      stop: async () => ({ verdict: { verdict: 'succeeded' as const } }),
    },
  });

  // The turn's start reads the run's roots; its end snapshots the same roots.
  expect(captureTurnBoundary.mock.calls.map(([request]) => request)).toEqual([
    { boundary: 'turn-start', runId, threadId },
    { boundary: 'turn-end', roots: [ROOT], runId, threadId },
  ]);
  const types = events.map((event) => event.type);
  const snapshots = events.flatMap((event, index) =>
    event.type === 'workspace.snapshot.recorded' ? [{ event, index }] : []
  );
  expect(snapshots.map(({ event }) => event)).toEqual([
    {
      boundary: 'turn-start',
      roots: [{ ...ROOT, commitOid: START_OID }],
      runId,
      type: 'workspace.snapshot.recorded',
    },
    {
      boundary: 'turn-end',
      roots: [{ ...ROOT, commitOid: END_OID }],
      runId,
      type: 'workspace.snapshot.recorded',
    },
  ]);
  // Start precedes the run's tool; the end follows its Stop label and ends the turn.
  expect(snapshots[0]?.index).toBeGreaterThan(types.indexOf('run.started'));
  expect(snapshots[0]?.index).toBeLessThan(types.indexOf('effect.started'));
  expect(types.slice(-3)).toEqual(['run.verdict', 'workspace.snapshot.recorded', 'run.finished']);
});

test('a failed capture is committed visibly and the run still completes', async () => {
  const captureTurnBoundary = vi.fn(async () => {
    throw new Error('The snapshot service is unavailable');
  });
  const { events, runId } = await runWith({ captureTurnBoundary });

  expect(events.filter((event) => event.type === 'workspace.snapshot.recorded')).toEqual([
    {
      boundary: 'turn-start',
      failure: 'The snapshot service is unavailable',
      roots: [],
      runId,
      type: 'workspace.snapshot.recorded',
    },
  ]);
  // With no turn-start roots there is no end to capture; the run is unaffected.
  expect(captureTurnBoundary).toHaveBeenCalledTimes(1);
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
});
