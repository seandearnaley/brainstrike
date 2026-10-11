import './agent-host-compile-cache';
import type { AgentHost } from '@brainstrike/agent-host';
import type { StartupMessage } from '@brainstrike/host-lease';
import { createUtilityParentInbox } from './utility-parent-inbox';

/** Electron provides a launcher channel; all agent work stays in the Node kernel. */
async function main(): Promise<void> {
  const parent = process.parentPort;
  if (!parent) {
    throw new Error('Agent host utility has no parent channel');
  }
  // BST-1977: CJS dependency evaluation used to precede the parent listener.
  // Capture first, then install the existing decoders before loading Core.
  const inbox = createUtilityParentInbox(parent);
  const controller = new AbortController();
  let cancelKernel: (() => void) | undefined;
  const cancel = (): void => {
    controller.abort(new Error('Host process cancelled'));
    cancelKernel?.();
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const release = (): void => {
    inbox.close();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  };
  let retained = false;
  let kernelStarted = false;
  let controlFailure: unknown;
  let host: AgentHost | undefined;
  try {
    const { receiveAgentHostParentMessage } = await import('./agent-host-parent-control');
    inbox.bind((input) => {
      try {
        receiveAgentHostParentMessage(input, host, cancel);
      } catch (cause) {
        controlFailure ??= cause;
        cancel();
      }
    });
    // Deliver queued native parent/port events before synchronous CJS evaluation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.signal.throwIfAborted();
    const { runAgentHostProcess } = await import('@brainstrike/agent-host');
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.signal.throwIfAborted();
    kernelStarted = true;
    await runAgentHostProcess(process.argv.slice(2), {
      listen: (stop) => {
        cancelKernel = stop;
        if (controller.signal.aborted) {
          stop();
        }
        return release;
      },
      report: async (message: StartupMessage) => {
        if (message.event === 'failed') {
          retained = message.ownership === 'retained';
        }
        parent.postMessage(message);
      },
      started: (acquired) => {
        host = acquired;
      },
    });
    if (controlFailure !== undefined) {
      throw controlFailure;
    }
    process.exit(0);
  } catch (cause) {
    const failure = kernelStarted ? cause : (controlFailure ?? cause);
    process.exitCode = 1;
    process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
    if (!kernelStarted) {
      parent.postMessage({
        event: 'failed',
        kind: 'error',
        message: failure instanceof Error ? failure.message : String(failure),
        ownership: 'released',
      } satisfies StartupMessage);
    }
    // Failed physical joins retain the real writer/root and parent listener.
    if (!retained) {
      release();
      process.exit(1);
    }
  }
}

void main().catch((cause: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`${String(cause)}\n`);
});
