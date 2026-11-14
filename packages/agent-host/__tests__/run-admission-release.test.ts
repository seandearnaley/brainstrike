/**
 * Core keeps every run of the process, so what a finished run still holds
 * stays in the host's memory until the app quits. A run's admission is its
 * whole tool set with their executors and validators and the instructions it
 * was admitted with: about 0.5 MB a run in the built app, which a heap
 * snapshot showed under `HostRunMap` for every run a session had finished.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryObjects } from 'node:v8';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission } from '../src/ports.js';
import { HostProviderRequest } from '../src/run-provider-request.ts';
import {
  blocked,
  crashableStorePort,
  finished,
  recordingAdmission,
  stream,
  text,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** Held by each admission this test hands out, so the heap can be asked how many are left. */
class AdmissionMarker {
  readonly runId: string;
  constructor(runId: string) {
    this.runId = runId;
  }
}

/** The admissions still reachable, after a full garbage collection. */
function liveAdmissions(): number {
  return Number(queryObjects(AdmissionMarker, { format: 'count' }));
}

/** A host whose admissions each hold a marker, and the runs whose admission has closed. */
async function openMarkedHost(
  model: MockLanguageModelV4,
  /** What each admission carries beside its tools. */
  carried: Pick<HostRunAdmission, 'providerRequest'> = {}
): Promise<{ readonly closed: string[]; readonly core: HostCore }> {
  const base: HostPlatform = {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
  const admit = recordingAdmission([])(base);
  const closed: string[] = [];
  const platform: HostPlatform = {
    ...base,
    admitRun: async (request): Promise<HostRunAdmission> => {
      const admission = await admit?.(request);
      if (!admission) {
        throw new Error('No admission');
      }
      const marker = new AdmissionMarker(request.runId);
      return {
        ...admission,
        ...carried,
        close: async () => {
          await admission.close?.();
          closed.push(marker.runId);
        },
      };
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'bs-admission-release-'));
  const store = await StateStore.open(dir);
  const core = await HostCore.open(crashableStorePort(store).port, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(dir, { force: true, recursive: true });
  });
  return { closed, core };
}

test('a run that has ended and closed no longer holds its admission', async () => {
  const { closed, core } = await openMarkedHost(
    new MockLanguageModelV4({ doStream: async () => stream(text('Done.')) })
  );
  const { threadId } = await core.startThread({ commandId: randomUUID() });

  const runIds: string[] = [];
  for (const prompt of ['First.', 'Second.', 'Third.']) {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt,
      threadId,
    });
    runIds.push(runId);
    await expect
      .poll(async () => (await core.read(threadId, 0)).some(finished(runId)), { timeout: 15_000 })
      .toBe(true);
  }
  // Every run's admission was acquired and, once its owner joined, closed.
  await expect.poll(() => closed, { timeout: 15_000 }).toEqual(runIds);

  // The host is still open and still knows all three runs.
  expect(await core.read(threadId, 0)).toEqual(
    expect.arrayContaining(
      runIds.map((runId) =>
        expect.objectContaining({ event: expect.objectContaining({ runId, type: 'run.finished' }) })
      )
    )
  );
  expect(liveAdmissions()).toBe(0);
});

/**
 * A Stop joins the run's owner, closing its admission, before the run's end
 * commits; the run's Stop hooks and turn end still read the admission in
 * between. So the admission goes when the end commits, not when it closes.
 */
test('a stopped run holds its admission until its end commits, and no longer', async () => {
  const requested = Promise.withResolvers<void>();
  const { closed, core } = await openMarkedHost(
    new MockLanguageModelV4({
      doStream: async (call) => {
        requested.resolve();
        return blocked(call);
      },
    })
  );
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Wait for the stop.',
    threadId,
  });
  await requested.promise;
  expect(liveAdmissions()).toBe(1);

  await core.stop({ commandId: randomUUID(), runId, threadId });
  expect(closed).toEqual([runId]);
  expect(await core.read(threadId, 0)).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({ outcome: 'stopped', runId, type: 'run.finished' }),
    })
  );
  expect(liveAdmissions()).toBe(0);
});

/**
 * A run's provider request holds its branch's whole committed transcript, so
 * one kept per finished run would grow with the square of a thread's runs.
 */
test('a run commits one receipt for each provider request, and once ended no longer holds the request', async () => {
  const { closed, core } = await openMarkedHost(
    new MockLanguageModelV4({ doStream: async () => stream(text('Done.')) }),
    { providerRequest: { provider: 'openai' } }
  );
  const { threadId } = await core.startThread({ commandId: randomUUID() });

  const runIds: string[] = [];
  for (const prompt of ['First.', 'Second.', 'Third.']) {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt,
      threadId,
    });
    runIds.push(runId);
    await expect
      .poll(async () => (await core.read(threadId, 0)).some(finished(runId)), { timeout: 15_000 })
      .toBe(true);
  }
  await expect.poll(() => closed, { timeout: 15_000 }).toEqual(runIds);

  const types = (await core.read(threadId, 0)).map((row) => row.event.type);
  const count = (type: string) => types.filter((found) => found === type).length;
  // One model call a run, and one receipt of what each call sent.
  expect(count('model.step')).toBe(3);
  expect(count('provider.request.prepared')).toBe(3);
  expect(Number(queryObjects(HostProviderRequest, { format: 'count' }))).toBe(0);
});
