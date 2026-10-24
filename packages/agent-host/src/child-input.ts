import { deriveHostInputRunCommandId, type HostRunState } from './core-state.ts';
import type { HostEvent, HostParams } from './protocol.ts';

type HostRunOutcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/**
 * BST-1932 (AT-09): accept human input for a running child. Its active run
 * ends after the step in flight, and the input starts the child's next run
 * under the given run settings. A restart interrupts the child (ADR-0010), so
 * input still waiting is not replayed.
 */
export async function acceptHostChildInput(
  run: HostRunState,
  isChild: boolean,
  params: HostParams<'run/input'>,
  accept: () => Promise<void>
): Promise<{ accepted: true }> {
  if (!isChild) {
    throw new Error('Human input reaches a running child; a thread queues its next message');
  }
  if (run.terminal || run.stopped) {
    throw new Error('The child is not running');
  }
  if (run.childInput) {
    throw new Error('The child is already taking input');
  }
  await accept();
  const { commandId: input, runId, ...settings } = params;
  run.steered = true;
  run.inputCommandId = deriveHostInputRunCommandId(input);
  run.childInput = { ...settings, commandId: run.inputCommandId, parentMessageId: runId };
  return { accepted: true };
}

/**
 * BST-2178: once the input's run/start (or its refusal) is committed, `run`
 * no longer holds the input; it names the run that command started. Right
 * after that commit it is the thread's only run whose user message is the
 * command's (a later regenerate copies the message, never the run).
 */
export function settleHostChildInput(
  run: HostRunState,
  runs: ReadonlyMap<string, HostRunState>
): void {
  run.childInput = undefined;
  const taken = [...runs.values()].find(
    (next) => next.threadId === run.threadId && next.branch.userMessageId === run.inputCommandId
  );
  if (taken) {
    run.inputRun = taken.id;
  }
}

/**
 * The input a settled child run hands to the child's next run, while the host
 * may still start one; its run's end takes it once. A run that was stopped or
 * ended some other way refuses it, so the input is committed as a failed run,
 * never dropped. The input stays on the run until that next run is committed:
 * until then the run is still taking it (core-child-runs.ts).
 */
export function takeHostChildInput(
  run: HostRunState,
  outcome: HostRunOutcome,
  open: boolean
): { readonly params: HostParams<'run/start'>; readonly refused?: Error } | undefined {
  const params = run.childInput;
  if (!(open && params)) {
    return;
  }
  if (run.stopped || outcome !== 'completed') {
    const ended = run.stopped ? 'stopped' : outcome;
    return {
      params,
      refused: new Error(`The child run ended ${ended} before it read this input.`),
    };
  }
  return { params };
}
