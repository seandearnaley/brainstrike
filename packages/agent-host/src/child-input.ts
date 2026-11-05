import { refusalError } from '@brainstrike/assistant-contract';
import { retainHostRunWork } from './core-run-lifecycle.ts';
import type { HostRunState } from './core-state.ts';
import type { HostParams } from './protocol.ts';

/**
 * BST-1932 (AT-09): accept human input for a running child. Its active run
 * ends after the step in flight, and the input starts the child's next run
 * under the given run settings. The committed run/input is the input's one
 * record (`foldHostAcceptedCommand`), so a restart still finds it.
 */
export async function acceptHostChildInput(
  run: HostRunState,
  isChild: boolean,
  accept: () => Promise<void>,
  /** The input's run, for an input whose commit landed after its run's `run.finished`. */
  takeLate: (run: HostRunState) => Promise<void>
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
  // The run's own end, committed first, could not take it: it starts the run itself.
  if (run.terminal) {
    retainHostRunWork(run, takeLate(run));
  }
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
 * The input an ended child run hands to the child's next run. A run that was
 * stopped, ended some other way, or that a restart found, refuses it, so the
 * input is committed as a failed run, never dropped. The input stays on the
 * run until that next run is committed: until then the run is still taking it
 * (core-child-runs.ts).
 */
export function takeHostChildInput(
  run: HostRunState,
  restarted: boolean
): { readonly params: HostParams<'run/start'>; readonly refused?: Error } | undefined {
  const params = run.childInput;
  if (!params) {
    return;
  }
  const ended = run.stopped ? 'stopped' : run.outcome;
  const reason = restarted
    ? 'The host restarted before the child read this input.'
    : ended === 'completed'
      ? undefined
      : `The child run ended ${ended} before it read this input.`;
  return reason === undefined
    ? { params }
    : { params, refused: refusalError('conflict', 'child.input-unread', reason) };
}
