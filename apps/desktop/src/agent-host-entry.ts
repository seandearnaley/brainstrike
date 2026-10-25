// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';
import { enableCompileCache } from 'node:module';
import type { AgentHost } from '@brainstrike/agent-host';
import type { StartupMessage } from '@brainstrike/host-lease';
import { lifecycleDelay } from '@brainstrike/host-lease/lifecycle-delays';
import { agentHostLifecycleDelays } from './agent-host-lifecycle-delays';
import { markDesktopShuttingDown } from './desktop-shutdown-flag';
import { createUtilityParentInbox, loadUtilityStartup } from './utility-parent-inbox';

/** Electron provides a launcher channel; all agent work stays in the Node kernel. */
async function main(): Promise<void> {
  // Node's on-disk compile cache, on before the host's module graph loads (the
  // dynamic imports below), as the CLI does. Worker threads enable their own.
  // https://nodejs.org/api/module.html#moduleenablecompilecacheoptions
  enableCompileCache();
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
    // A signal to Main's process group, or Main's close: the host's children ending
    // under its work from here on are its shutdown, as they are Main's (ADR-0015).
    markDesktopShuttingDown();
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
  let terminalControl: Promise<void> | undefined;
  try {
    // Wait for the parent's existing lifetime channel before evaluating the
    // dependency graph. An initial setImmediate can precede Electron's first
    // native message dispatch, leaving an already queued Close behind imports.
    await loadUtilityStartup(() => inbox.received, controller.signal);
    const { receiveAgentHostParentMessage } = await loadUtilityStartup(
      () => import('./agent-host-parent-control'),
      controller.signal
    );
    inbox.bind((input) => {
      try {
        const clearing = receiveAgentHostParentMessage(input, host, cancel);
        if (clearing) {
          terminalControl = clearing.then((receipt) => {
            parent.postMessage({ event: 'content-cleared', ...receipt });
          });
          terminalControl.catch((cause: unknown) => {
            controlFailure ??= cause;
          });
        }
      } catch (cause) {
        controlFailure ??= cause;
        cancel();
      }
    });
    // Deliver queued native parent/port events before synchronous CJS evaluation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.signal.throwIfAborted();
    const { runAgentHostProcess } = await loadUtilityStartup(
      () => import('@brainstrike/agent-host'),
      controller.signal
    );
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
        if (message.event === 'ready') {
          await lifecycleDelay(agentHostLifecycleDelays, 'host-ready');
        }
        parent.postMessage(message);
      },
      started: (acquired) => {
        host = acquired;
      },
    });
    await terminalControl;
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
