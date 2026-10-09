import { randomUUID } from 'node:crypto';
import type { HostRunState } from './core-state.js';
import type { HostEvent, HostParams } from './protocol.js';

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
  const { commandId: _input, runId, ...settings } = params;
  run.steered = true;
  run.childInput = { ...settings, commandId: randomUUID(), parentMessageId: runId };
  return { accepted: true };
}

/**
 * Take the input a settled child run hands to the child's next run, once,
 * while the host may still start one. A run that was stopped or ended some
 * other way refuses it, so the input is committed as a failed run, never
 * dropped.
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
  run.childInput = undefined;
  if (run.stopped || outcome !== 'completed') {
    const ended = run.stopped ? 'stopped' : outcome;
    return {
      params,
      refused: new Error(`The child run ended ${ended} before it read this input.`),
    };
  }
  return { params };
}
