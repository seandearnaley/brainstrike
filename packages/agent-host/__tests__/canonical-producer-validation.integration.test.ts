import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { toStandardSchema } from '@mastra/schema-compat/schema';
import type { JSONSchema7 } from 'ai';
import { expect, test } from 'vitest';
import { createAgentHostToolBindings } from '../src/adapters/canonical-tool-bindings.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

// Raw MCP grammar, including a composed constraint that cannot be narrowed through Zod.
const grammar: JSONSchema7 = {
  $defs: { identifier: { minLength: 1, type: 'string' } },
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: { id: { $ref: '#/$defs/identifier' } },
  required: ['id'],
  type: 'object',
};

test.each(['invalid initial', 'live approval', 'reopened approval', 'invalid resumed'] as const)(
  'canonical producer validation: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-producer-validation-'));
    let store = await StateStore.open(root);
    let validations = 0;
    let executions = 0;
    const contexts: unknown[] = [];
    let rejectOnReopen = false;
    const actual = toStandardSchema(grammar);
    const bindings = createAgentHostToolBindings({
      bindings: { write: { identity: 'write-generation-1', risk: 'edit' } },
      resolvedToolResultBudget: resolveScaledToolResultBudget(128_000),
      tools: {
        write: {
          description: 'Host-owned producer with the MCP executable validator',
          execute: async (_input, context) => {
            executions += 1;
            contexts.push(context);
            return { written: true };
          },
          id: 'write',
          inputSchema: {
            '~standard': {
              ...actual['~standard'],
              validate: async (input: unknown) => {
                validations += 1;
                if (rejectOnReopen) {
                  return {
                    issues: [{ message: 'Resumed action no longer meets the executable contract' }],
                  };
                }
                return await actual['~standard'].validate(input);
              },
            },
          },
        },
      },
    });
    const platform: HostPlatform = {
      close: async () => undefined,
      maxSteps: 2,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () =>
        scriptedToolSequence([
          { input: { id: mode === 'invalid initial' ? '' : 'valid' }, toolId: 'write' },
        ]),
      tools: bindings.tools,
    };
    const diagnostics = captureHostFailureDiagnostics();
    let core = await HostCore.open(store, platform, () => () => undefined);
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Write',
        threadId,
      });
      if (mode !== 'invalid initial') {
        let pending: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
        await expect
          .poll(async () => {
            pending = (await core.read(threadId, 0))
              .map((row) => row.event)
              .find((event) => event.type === 'interaction.requested');
            return pending !== undefined;
          })
          .toBe(true);
        if (!pending) {
          throw new Error('Expected an approval');
        }
        expect(validations).toBe(1);
        expect(executions).toBe(0);
        if (mode !== 'live approval') {
          await core.close();
          await store.close();
          rejectOnReopen = mode === 'invalid resumed';
          store = await StateStore.open(root);
          core = await HostCore.open(store, platform, () => () => undefined);
        }
        await core.respond({
          commandId: randomUUID(),
          decision: 'approve',
          interactionId: pending.interactionId,
          runId,
          threadId,
        });
      }
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
        .toBe(true);
      expect(executions).toBe(mode === 'live approval' || mode === 'reopened approval' ? 1 : 0);
      expect(validations).toBe(mode === 'live approval' || mode === 'invalid initial' ? 1 : 2);
      if (executions === 1) {
        expect(contexts).toEqual([
          expect.objectContaining({ runId, threadId, toolCallId: 'recorded-call-1' }),
        ]);
        expect(
          (await core.read(threadId, 0)).find((row) => row.event.type === 'run.finished')?.event
        ).toMatchObject({ outcome: 'completed' });
      }
      if (mode === 'invalid resumed') {
        expect(
          (await core.read(threadId, 0)).some((row) => row.event.type === 'effect.started')
        ).toBe(false);
        diagnostics.expectCause('Resumed action no longer meets the executable contract');
      }
    } finally {
      await core.close();
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
