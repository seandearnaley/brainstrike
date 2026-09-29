/**
 * A LEG THAT CANNOT MAP ITS NATIVE RUN OWNS A STREAM IT NEVER READS
 * (BST-1749, final review item 3).
 *
 * `recordRootNativeRun` runs AFTER `agent.stream` has constructed the native
 * output: a missing run id, a missing host port or a host that refuses the
 * mapping all throw with that stream already built. Its caller's `catch`
 * aborts and disposes the runtime, but nothing reads the stream to its close —
 * and Mastra's terminal cleanup (its cancel persistence and two
 * `mastra_workflow_snapshot` DELETEs) only runs on that close, so an
 * un-settled stream floats those statements past the end of the turn and
 * races the storage close (BST-1221). Every neighbouring binding step
 * (`wakeNativeConversation`, `bindStartedNativeBranch`) already aborts and
 * consumes on failure; this one settles through `settleNativeStream` with the
 * leg's own abort context, so the join is also bounded by its deadline.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MastraAgentRuntime } from '../agent-runtime';
import { recordRootNativeRun } from '../background-granted-approvals';

function backgroundRuntime(
  recordNativeRootRun: ((nativeRunId: string) => Promise<void>) | undefined,
  childExecution = false
): MastraAgentRuntime {
  return {
    backgroundTaskManager: {},
    ...(childExecution ? { childExecution: { maxSteps: 4 } } : {}),
    conversationBinding: recordNativeRootRun ? { recordNativeRootRun } : {},
  } as unknown as MastraAgentRuntime;
}

function abortContext() {
  const controller = new AbortController();
  return { abort: vi.fn((reason: Error) => controller.abort(reason)), signal: controller.signal };
}

function nativeOutput(runId: string | undefined, consumeStream = vi.fn(async () => {})) {
  return { consumeStream, ...(runId === undefined ? {} : { runId }) };
}

describe('recordRootNativeRun', () => {
  it('maps the run and leaves the stream to its consumer', async () => {
    const mapped: string[] = [];
    const output = nativeOutput('native-run-1');
    const context = abortContext();

    await recordRootNativeRun(
      backgroundRuntime(async (nativeRunId) => {
        mapped.push(nativeRunId);
      }),
      output,
      context
    );

    expect(mapped).toEqual(['native-run-1']);
    expect(output.consumeStream).not.toHaveBeenCalled();
    expect(context.signal.aborted).toBe(false);
  });

  it('settles the stream it abandoned when the turn has no native run id', async () => {
    const output = nativeOutput(undefined);
    const context = abortContext();

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {}),
        output,
        context
      )
    ).rejects.toThrow('Background work requires the native run id of its own turn.');

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
    expect(context.signal.aborted).toBe(true);
  });

  it('settles the stream when the host has no native-run port at all', async () => {
    const output = nativeOutput('native-run-1');
    const context = abortContext();

    await expect(
      recordRootNativeRun(backgroundRuntime(undefined), output, context)
    ).rejects.toThrow(/recordNativeRootRun/);

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
    expect(context.signal.aborted).toBe(true);
  });

  it('settles the stream when the host refuses the mapping', async () => {
    const output = nativeOutput('native-run-1');
    const refusal = new Error('native-run-generation-mismatch');
    const context = abortContext();

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {
          throw refusal;
        }),
        output,
        context
      )
    ).rejects.toBe(refusal);

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
    expect(context.signal.aborted).toBe(true);
  });

  it('surfaces the refusal itself when settling the abandoned stream also fails', async () => {
    // The settlement records its own failure (settleNativeStream never
    // throws), so a caller discriminating on the refusal still sees it.
    const output = nativeOutput(
      'native-run-1',
      vi.fn(() => Promise.reject(new Error('stream settlement failed')))
    );
    const refusal = new Error('native-run-generation-mismatch');

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {
          throw refusal;
        }),
        output,
        abortContext()
      )
    ).rejects.toBe(refusal);
  });

  it('touches nothing on a leg that maps no root run', async () => {
    const output = nativeOutput(undefined);

    await recordRootNativeRun(
      backgroundRuntime(async () => {}, true),
      output,
      abortContext()
    );

    expect(output.consumeStream).not.toHaveBeenCalled();
  });
});
