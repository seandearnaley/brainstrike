import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { modelMessageSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore, jsonValue } from '../src/core.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

// BST-1977: OPEN third input-reconstruction repair; no quarantine waiver.
test.skipIf(process.env['BRAINSTRIKE_M3_APPROVAL_HISTORY_REPRO'] !== '1')(
  'approving a later run preserves prior committed calls when the public fixture reuses its call ID',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-approval-history-'));
    const store = await StateStore.open(root);
    const dates = ['2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z'] as const;
    const providerPrompts: unknown[] = [];
    const executed: unknown[] = [];
    const core = await HostCore.open(
      store,
      {
        close: async () => undefined,
        maxSteps: 3,
        readPermissionPolicy: () => ({
          policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
          yolo: false,
        }),
        resolveModel: async (modelId) => {
          const date = modelId === 'date-first' ? dates[0] : dates[1];
          const source = scriptedToolSequence([{ input: { at: date }, toolId: 'runtime_date' }]);
          return new MockLanguageModelV4({
            doStream: async (options) => {
              if (modelId === 'date-second') {
                providerPrompts.push(jsonValue(options.prompt));
              }
              return source.doStream(options);
            },
          });
        },
        tools: {
          runtime_date: {
            description: 'Recorded Date runtime input',
            execute: async (input) => {
              executed.push(input);
              if (
                !(input && typeof input === 'object' && 'at' in input && input.at instanceof Date)
              ) {
                throw new TypeError('Expected validated Date');
              }
              return { at: input.at.toISOString() };
            },
            identity: 'runtime-date',
            inputSchema: z.object({ at: z.iso.datetime().transform((value) => new Date(value)) }),
            risk: 'edit',
          },
        },
      },
      () => () => undefined
    );
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      for (const modelId of ['date-first', 'date-second'] as const) {
        const { runId } = await core.startRun({
          commandId: randomUUID(),
          modelId,
          prompt: 'Read this recorded date.',
          threadId,
        });
        let approval: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
        await expect
          .poll(async () => {
            approval = (await core.read(threadId, 0))
              .map((row) => row.event)
              .find(
                (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
                  event.type === 'interaction.requested' && event.runId === runId
              );
            return approval !== undefined;
          })
          .toBe(true);
        if (!approval) {
          throw new Error('Expected current-run approval');
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
            (await core.read(threadId, 0)).some(
              (row) => row.event.type === 'run.finished' && row.event.runId === runId
            )
          )
          .toBe(true);
      }
      const rows = await core.read(threadId, 0);
      const committedCalls = rows
        .flatMap((row) => (row.event.type === 'model.step' ? row.event.messages : []))
        .flatMap((value) => {
          const message = modelMessageSchema.parse(value);
          return message.role === 'assistant' && typeof message.content !== 'string'
            ? message.content
                .filter((part) => part.type === 'tool-call')
                .map((part) => ({ input: part.input, toolCallId: part.toolCallId }))
            : [];
        });
      const modelPrompt = providerPrompts
        .map((value) => z.array(z.unknown()).parse(value))
        .findLast(
          (prompt) =>
            prompt.flatMap((value) => {
              const message = modelMessageSchema.parse(value);
              return message.role === 'assistant' && typeof message.content !== 'string'
                ? message.content.filter((part) => part.type === 'tool-call')
                : [];
            }).length === 2
        );
      if (!modelPrompt) {
        throw new Error('Expected real provider prompt with both recorded calls');
      }
      const promptCalls = modelPrompt.flatMap((value) => {
        const message = modelMessageSchema.parse(value);
        return message.role === 'assistant' && typeof message.content !== 'string'
          ? message.content
              .filter((part) => part.type === 'tool-call')
              .map((part) => ({ input: part.input, toolCallId: part.toolCallId }))
          : [];
      });
      await writeFile(
        '/tmp/brainstrike-m3-approval-history-repro.json',
        JSON.stringify({ committedCalls, executed, modelPrompt, promptCalls }, null, 2)
      );
      expect(committedCalls).toEqual(
        dates.map((at) => ({ input: { at }, toolCallId: 'recorded-call-1' }))
      );
      expect(promptCalls).toEqual(committedCalls);
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
