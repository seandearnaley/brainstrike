import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

class RuntimeSelection {
  constructor(readonly text: string) {}
}

class ArrayRuntimeSelection extends Array<number> {
  constructor(readonly selection: string) {
    super();
    this.push(1);
  }
}

test.each([
  { effects: 0, reconstruct: false, shape: 'subclass' },
  { effects: 0, reconstruct: false, shape: 'extra property' },
  { effects: 0, reconstruct: false, shape: 'prototype property' },
  { effects: 0, reconstruct: false, shape: 'record prototype property' },
  { effects: 0, reconstruct: false, shape: 'cross-realm array' },
  { effects: 0, reconstruct: false, shape: 'cross-realm record' },
  { effects: 1, reconstruct: true, shape: 'cross-realm array' },
  { effects: 1, reconstruct: true, shape: 'cross-realm record' },
  { effects: 1, reconstruct: false, shape: 'ordinary array' },
  { effects: 1, reconstruct: false, shape: 'ordinary record' },
  { effects: 1, reconstruct: false, shape: 'null-prototype record' },
] as const)(
  'reopened approval runtime meaning ($shape, reconstruction=$reconstruct)',
  async ({ effects, reconstruct, shape }) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-array-input-'));
    let store = await StateStore.open(root);
    let selection = 'first process selection';
    let executions = 0;
    const schema = z.object({ text: z.string() }).transform(({ text }): unknown => {
      if (shape === 'cross-realm array') {
        return runInNewContext('[1]') as unknown;
      }
      if (shape === 'cross-realm record') {
        return runInNewContext('({text: "recorded action"})') as unknown;
      }
      if (shape === 'ordinary array') {
        return [1];
      }
      if (shape === 'ordinary record') {
        return { text };
      }
      if (shape === 'null-prototype record') {
        return Object.assign(Object.create(null) as Record<string, unknown>, { text });
      }
      if (shape === 'record prototype property') {
        return Object.setPrototypeOf(
          { text },
          Object.assign(Object.create(null) as Record<string, unknown>, { selection })
        );
      }
      if (shape === 'subclass') {
        return new ArrayRuntimeSelection(selection);
      }
      if (shape === 'prototype property') {
        return Object.setPrototypeOf(
          [1],
          Object.setPrototypeOf(
            Object.assign([], { map: Array.prototype.map, selection }),
            Object.prototype
          )
        );
      }
      return Object.assign([1], { selection });
    });
    const platform: HostPlatform = {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () =>
        scriptedToolSequence([{ input: { text: 'recorded action' }, toolId: 'selection' }]),
      tools: {
        selection: {
          description: 'Array input with selection omitted by JSON',
          execute: async () => {
            executions += 1;
            return { executed: true };
          },
          identity: 'array-selection',
          inputSchema: schema,
          ...(reconstruct
            ? { reconstructApprovalInput: (raw: unknown) => schema.parseAsync(raw) }
            : {}),
          risk: 'edit',
        },
      },
    };
    let core = await HostCore.open(store, platform, () => () => undefined);
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Select',
        threadId,
      });
      await expect
        .poll(async () => {
          const rows = await core.read(threadId, 0);
          const terminal = rows.find((row) => row.event.type === 'run.finished');
          if (terminal?.event.type === 'run.finished') {
            throw new Error(terminal.event.detail ?? terminal.event.outcome);
          }
          return rows.some((row) => row.event.type === 'interaction.requested');
        })
        .toBe(true);
      const pending = (await core.read(threadId, 0))
        .map((row) => row.event)
        .find((event) => event.type === 'interaction.requested');
      if (!pending) {
        throw new Error('Expected array approval');
      }
      await core.close();
      await store.close();
      selection = 'different process selection';
      store = await StateStore.open(root);
      core = await HostCore.open(store, platform, () => () => undefined);
      await core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: pending.interactionId,
        runId,
        threadId,
      });
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
        .toBe(true);
      expect(executions).toBe(effects);
      expect(
        (await core.read(threadId, 0)).some((row) => row.event.type === 'effect.started')
      ).toBe(effects === 1);
      expect(
        (await core.read(threadId, 0)).find((row) => row.event.type === 'run.finished')?.event
      ).toMatchObject({ outcome: effects === 1 ? 'completed' : 'interrupted' });
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);

test.each(['live', 'reopened'] as const)(
  'approval keeps live validated meaning and interrupts unreconstructable JSON meaning (%s)',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-runtime-input-'));
    let store = await StateStore.open(root);
    let admitted: RuntimeSelection | undefined;
    let executed: unknown;
    let executions = 0;
    const schema = z.object({ text: z.string() }).transform(({ text }) => {
      admitted = new RuntimeSelection(text);
      return admitted;
    });
    const platform: HostPlatform = {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () =>
        scriptedToolSequence([{ input: { text: 'recorded action' }, toolId: 'runtime_selection' }]),
      tools: {
        runtime_selection: {
          description: 'Recorded tool input requiring runtime class semantics',
          execute: async (input) => {
            executed = input;
            executions += 1;
            return { executed: true };
          },
          identity: 'runtime-selection',
          inputSchema: schema,
          risk: 'edit',
        },
      },
    };
    let core = await HostCore.open(store, platform, () => () => undefined);
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Perform the recorded action',
        threadId,
      });
      let approval: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
      await expect
        .poll(async () => {
          approval = (await core.read(threadId, 0))
            .map((row) => row.event)
            .find((event) => event.type === 'interaction.requested');
          return approval !== undefined;
        })
        .toBe(true);
      if (!approval) {
        throw new Error('Expected committed runtime-input approval');
      }
      const liveInput = admitted;
      if (mode === 'reopened') {
        await core.close();
        await store.close();
        store = await StateStore.open(root);
        core = await HostCore.open(store, platform, () => () => undefined);
      }
      await core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: approval.interactionId,
        runId,
        threadId,
      });
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
        .toBe(true);
      if (mode === 'live') {
        expect(executed).toBe(liveInput);
        expect(executions).toBe(1);
      } else {
        expect(executions).toBe(0);
        expect(
          (await core.read(threadId, 0)).some((row) => row.event.type === 'effect.started')
        ).toBe(false);
        expect(
          (await core.read(threadId, 0)).find((row) => row.event.type === 'run.finished')?.event
        ).toMatchObject({
          detail: 'Pending approval requires tool-owned runtime input reconstruction',
          outcome: 'interrupted',
        });
      }
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
