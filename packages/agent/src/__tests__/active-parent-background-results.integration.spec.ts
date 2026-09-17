import { expect, it, vi } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each([false, true])(
  'presents the last child outcome in an active parent (continuation=%s)',
  async (continuation) => {
    const fixture = await createBackgroundFixture(
      false,
      undefined,
      false,
      undefined,
      false,
      1,
      continuation ? { heldSibling: 2, siblings: 2 } : {}
    );
    const parentEntered = Promise.withResolvers<void>();
    const parentRelease = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const watching = new AbortController();
    const manager = fixture.runtime.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing background manager');
    }
    const reader = manager.stream({ ...fixture.scope, abortSignal: watching.signal }).getReader();
    let completed = 0;
    const observation = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value['type'] === 'background-task-completed') {
          completed += 1;
          if (completed === (continuation ? 2 : 1)) {
            terminal.resolve();
            return;
          }
        }
      }
    })();
    const original = fixture.model.model.doStream.bind(fixture.model.model);
    let held = false;
    let nextPrompt: Parameters<typeof fixture.model.model.doStream>[0]['prompt'] | undefined;
    let runsAtNextStep = 0;
    const parentRead = scriptedAgentModel(() =>
      toolCallParts('brainstrike_grepSearch', 'parent-read', { pattern: 'parent-evidence' })
    );
    const parentAnswer = scriptedAgentModel(() => textParts('PARENT_REPORT'));
    const spy = vi.spyOn(fixture.model.model, 'doStream').mockImplementation(async (options) => {
      const root = options.tools?.some((tool) => tool.name === 'agent-explore');
      if (
        root &&
        hasToolResult(options, 'agent-explore') &&
        (!continuation || fixture.nativeRootRuns.length > 1)
      ) {
        if (!held) {
          held = true;
          parentEntered.resolve();
          await parentRelease.promise;
          return parentRead.model.doStream(options);
        }
        if (nextPrompt === undefined) {
          nextPrompt = options.prompt;
          runsAtNextStep = fixture.nativeRootRuns.length;
        }
        return parentAnswer.model.doStream(options);
      }
      return original(options);
    });
    let consuming: Promise<void> | undefined;
    try {
      const iterator = await createStreamIteratorFromRuntime({
        memory: fixture.backing.memory,
        messages: [{ id: 'task', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
        runtime: fixture.runtime,
        runtimeData: fixture.runtimeData,
      });
      consuming = (async () => {
        for await (const _chunk of iterator) {
          /* drain */
        }
      })();
      consuming.catch(() => {});
      await fixture.entered.promise;
      if (continuation) {
        fixture.release.resolve();
      }
      await parentEntered.promise;
      fixture.release.resolve();
      fixture.hold.resolve();
      await terminal.promise;
      parentRelease.resolve();
      await consuming;
      expect(runsAtNextStep).toBe(continuation ? 2 : 1);
      expect(fixture.nativeRootRuns).toHaveLength(runsAtNextStep);
      expect(parentAnswer.prompts).toHaveLength(1);
      expect(JSON.stringify(nextPrompt)).toContain('Nothing is still running');
      expect(JSON.stringify(nextPrompt)).toContain('CHILD_FINAL_EVIDENCE');
      const notice = nextPrompt?.filter((message) => message.role === 'user').at(-1);
      expect(JSON.stringify(notice)).toContain(continuation ? '2 returned' : '1 returned');
      expect(JSON.stringify(notice)).toContain('Saved terminal outcomes');
      expect(JSON.stringify(notice)).toContain(
        continuation ? 'background-child-2' : 'background-child'
      );
      expect(JSON.stringify(notice)).toContain('CHILD_FINAL_EVIDENCE');
      expect(
        (
          await fixture.database.query(
            "SELECT id FROM mastra_messages WHERE id LIKE 'active-background-results:%'"
          )
        ).rows
      ).toEqual([]);
    } finally {
      fixture.release.resolve();
      fixture.hold.resolve();
      parentRelease.resolve();
      watching.abort();
      await Promise.allSettled([consuming, observation]);
      reader.releaseLock();
      spy.mockRestore();
      await fixture.runtime.dispose();
      await fixture.database.close();
    }
  }
);
