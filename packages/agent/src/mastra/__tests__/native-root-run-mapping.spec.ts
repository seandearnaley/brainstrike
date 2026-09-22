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
 * consumes on failure; this one does too.
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

function nativeOutput(runId: string | undefined, consumeStream = vi.fn(async () => {})) {
  return { consumeStream, ...(runId === undefined ? {} : { runId }) };
}

describe('recordRootNativeRun', () => {
  it('maps the run and leaves the stream to its consumer', async () => {
    const mapped: string[] = [];
    const output = nativeOutput('native-run-1');
    const abort = vi.fn();

    await recordRootNativeRun(
      backgroundRuntime(async (nativeRunId) => {
        mapped.push(nativeRunId);
      }),
      output,
      abort
    );

    expect(mapped).toEqual(['native-run-1']);
    expect(output.consumeStream).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it('settles the stream it abandoned when the turn has no native run id', async () => {
    const output = nativeOutput(undefined);
    const abort = vi.fn();

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {}),
        output,
        abort
      )
    ).rejects.toThrow('Background work requires the native run id of its own turn.');

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('settles the stream when the host has no native-run port at all', async () => {
    const output = nativeOutput('native-run-1');

    await expect(
      recordRootNativeRun(backgroundRuntime(undefined), output, vi.fn())
    ).rejects.toThrow(/recordNativeRootRun/);

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
  });

  it('settles the stream when the host refuses the mapping', async () => {
    const output = nativeOutput('native-run-1');
    const refusal = new Error('native-run-generation-mismatch');

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {
          throw refusal;
        }),
        output,
        vi.fn()
      )
    ).rejects.toBe(refusal);

    expect(output.consumeStream).toHaveBeenCalledTimes(1);
  });

  it('keeps both causes when settling the abandoned stream also fails', async () => {
    const settleFailure = new Error('stream settlement failed');
    const output = nativeOutput(
      'native-run-1',
      vi.fn(() => Promise.reject(settleFailure))
    );
    const refusal = new Error('native-run-generation-mismatch');

    await expect(
      recordRootNativeRun(
        backgroundRuntime(async () => {
          throw refusal;
        }),
        output,
        vi.fn()
      )
    ).rejects.toMatchObject({ errors: [refusal, settleFailure] });
  });

  it('touches nothing on a leg that maps no root run', async () => {
    const output = nativeOutput(undefined);

    await recordRootNativeRun(
      backgroundRuntime(async () => {}, true),
      output,
      vi.fn()
    );

    expect(output.consumeStream).not.toHaveBeenCalled();
  });
});
