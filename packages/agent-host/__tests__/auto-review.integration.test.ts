/**
 * Auto access mode: a call the policy asks about is reviewed by the quick
 * model first. Its approval runs the call with no card; a flag or a failed
 * review asks the user, and the card says why.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** A quick model that answers every review with `answer`, recording each prompt. */
function reviewer(answer: Record<string, string>, prompts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ text: JSON.stringify(answer), type: 'text' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
}

async function runCommand(
  reviewModel: (target: string) => Promise<LanguageModel>
): Promise<{ events: HostEvent[]; executed: unknown[]; targets: string[] }> {
  const executed: unknown[] = [];
  const targets: string[] = [];
  const commandTool: HostTool = {
    description: 'command fixture',
    execute: async (input) => {
      executed.push(input);
      return { ok: true };
    },
    identity: 'command-generation-1',
    inputSchema: z.object({ command: z.string() }).strict(),
    permissionToolId: 'brainstrike.executeCommand',
    risk: 'execute',
  };
  const root = await mkdtemp(join(tmpdir(), 'bs-auto-review-'));
  const store = await StateStore.open(root);
  const tools = { execute_command: commandTool };
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model: scriptedToolSequence([{ input: { command: 'pnpm test' }, toolId: 'execute_command' }]),
      reviewModel: async (target) => {
        targets.push(target);
        return await reviewModel(target);
      },
      snapshot: {
        configuration: {},
        maxSteps: 3,
        toolIdentities: { execute_command: commandTool.identity },
      },
      tools,
    }),
    close: async () => undefined,
    readPermissionPolicy: () => ({
      autoReview: { model: 'auto' },
      policies: { ...DEFAULT_PERMISSION_POLICIES },
      yolo: false,
    }),
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run the tests.',
    threadId,
  });
  let events: HostEvent[] = [];
  await expect
    .poll(async () => {
      events = (await core.read(threadId, 0)).map((row) => row.event);
      return events.some(
        (event) => event.type === 'interaction.requested' || event.type === 'run.finished'
      );
    })
    .toBe(true);
  return { events, executed, targets };
}

const requested = (events: readonly HostEvent[]) =>
  events.find(
    (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
      event.type === 'interaction.requested'
  );

test('a call the quick model approves runs without asking, and the review sees the request', async () => {
  const prompts: string[] = [];
  const { events, executed, targets } = await runCommand(async () =>
    reviewer(
      {
        decision: 'approve',
        rationale: 'The user asked to run the tests.',
        risk: 'low',
        userAuthorization: 'high',
      },
      prompts
    )
  );

  expect(requested(events)).toBeUndefined();
  expect(executed).toEqual([{ command: 'pnpm test' }]);
  expect(targets).toEqual(['auto']);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Run the tests.');
  expect(prompts[0]).toContain('brainstrike.executeCommand');
});

test('a call the quick model flags asks the user and says why', async () => {
  const { events, executed } = await runCommand(async () =>
    reviewer(
      {
        decision: 'ask-user',
        rationale: 'It deletes files outside the task.',
        risk: 'high',
        userAuthorization: 'low',
      },
      []
    )
  );

  expect(executed).toEqual([]);
  expect(requested(events)?.reason).toBe(
    'Auto-review flagged this: It deletes files outside the task.'
  );
});

test('an approve the quick model itself calls high risk still asks the user', async () => {
  const { events, executed } = await runCommand(async () =>
    reviewer(
      { decision: 'approve', rationale: 'Probably fine.', risk: 'high', userAuthorization: 'low' },
      []
    )
  );

  expect(executed).toEqual([]);
  expect(requested(events)?.reason).toBe('Auto-review flagged this: Probably fine.');
});

test('a review that fails asks the user instead of approving', async () => {
  const { events, executed } = await runCommand(async () => {
    throw new Error('No quick model is known for this provider');
  });

  expect(executed).toEqual([]);
  expect(requested(events)?.reason).toBe(
    'Auto-review could not check this action (Error), so it needs your approval.'
  );
});
