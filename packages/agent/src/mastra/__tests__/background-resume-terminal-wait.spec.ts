import { describe, expect, it } from 'vitest';
import type { DelegatedWakeupRecord } from '../delegated-conversation-binding';
import { createLiveDecisionChannel, LiveDecisionUnavailableError } from '../live-decision-channel';
import {
  createNativeManager,
  macrotask,
  parkingTool,
  startLeg,
  TOOL,
  until,
} from './fixtures/background-resume-harness';

describe('createBackgroundResumeStream terminal wait (BST-1749)', () => {
  it('refuses a reservation once every awaited terminal is in, while the leg still joins its final ledger row', async () => {
    // The last terminal ends the wait and starts the leg's final ledger read
    // in the same turn. A decision that reaches `reserve` from then on — here
    // as that read starts, before the leg's own continuation runs — is refused
    // as not live (KNOWN LIMITS), never added to a wait that has ended.
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ cancelOnResume: new Set(['t1']) });
    const sibling = native.add('t2');
    let reservation: unknown;
    const release = native.holdNextRead(() => {
      try {
        channel.owner?.reserve([sibling]);
        reservation = 'accepted';
      } catch (error) {
        reservation = error;
      }
    });
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await until(() => reservation !== undefined);
    release();
    expect(reservation).toBeInstanceOf(LiveDecisionUnavailableError);
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('keeps awaiting a task a second reservation resumed when the first gives it back', async () => {
    // Two deliveries can name the SAME suspended row — one as the user's own
    // answer, one as a granted sibling of another user's answer. Each holds
    // the task in the wait on its own account: the give-back of a decision
    // whose host record failed must not stop the leg observing a task the
    // other decision resumed, or the leg ends with that task's terminal
    // missing and the parent's wakeup is short an invocation.
    const legRunning = Promise.withResolvers<void>();
    const siblingRunning = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const recorded: DelegatedWakeupRecord[] = [];
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      recordWakeup: async (record) => {
        recorded.push(record);
      },
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async (args, options) => {
            if (String(args['prompt']).endsWith('t2')) {
              await siblingRunning.promise;
              return;
            }
            await legRunning.promise;
            await options.suspend?.({ reason: 'next gated read' });
          },
        },
      }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // The granted-sibling delivery reserves the row first; the user's own
      // answer for that same row reserves it a moment later and resumes it.
      const granted = owner.reserve([sibling]);
      const explicit = owner.reserve([sibling]);
      await explicit.resume([{ resumeData: { approved: true }, task: sibling }]);
      await until(() => native.calls.includes('execute:t2'));
      // The granted delivery's host record failed after the other resumed.
      granted.release();
      native.cancel('t2');
    } finally {
      siblingRunning.resolve();
      legRunning.resolve();
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    // The cancelled child is returned work: the parked root defers its wakeup,
    // and that record names the task whose terminal the leg kept.
    expect(recorded.flatMap((record) => record.invocations.map((one) => one.taskId))).toEqual([
      't2',
    ]);
  }, 2000);

  it('gives a task back once for every reservation that named it', async () => {
    // The dual of the row above: every reservation that names a task holds it
    // in the wait, so every one of them must be able to give it back. A
    // holder that cannot leaves the leg waiting for the terminal of a task
    // nobody resumed — the wait never completes and the leg never closes.
    const legRunning = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseResume: new Set(['t2']) });
    const sibling = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(legRunning.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const granted = owner.reserve([sibling]);
      const explicit = owner.reserve([sibling]);
      // Mastra refuses both deliveries: the row was answered on another leg.
      await expect(
        explicit.resume([{ resumeData: { approved: true }, task: sibling }])
      ).rejects.toThrow("Cannot resume task in status 'cancelled'");
      await expect(
        granted.resume([{ resumeData: { approved: true }, task: sibling }])
      ).rejects.toThrow("Cannot resume task in status 'cancelled'");
      legRunning.resolve();
      // Nothing holds t2 any more, so the leg's own terminal completes the wait.
      await until(() => native.calls.includes('shutdown'));
    } finally {
      legRunning.resolve();
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('refuses a reservation once a stopped leg stopped waiting, while it still joins its final ledger row', async () => {
    const stop = new AbortController();
    const gate = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const other = native.add('t9');
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(gate.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      let reading = false;
      const release = native.holdNextRead(() => {
        reading = true;
      });
      // Another child's terminal starts a ledger read; the Stop then ends the
      // lifecycle stream while that row is still being joined.
      native.cancel(other.id);
      await until(() => reading);
      stop.abort(new Error('User stopped the root.'));
      await macrotask();
      await macrotask();
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The stopped leg released its owner before its final ledger row.');
      }
      expect(() => owner.reserve([sibling])).toThrow(LiveDecisionUnavailableError);
      release();
      const { error } = await ended;
      expect(error).toMatchObject({ message: 'User stopped the root.' });
    } finally {
      gate.resolve();
    }
  }, 2000);
});
