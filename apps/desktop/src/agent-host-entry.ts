import './agent-host-compile-cache';
import { appendFileSync } from 'node:fs';
import { flushCompileCache } from 'node:module';
import { join } from 'node:path';
import type { AgentHost } from '@brainstrike/agent-host';
import type { StartupMessage } from '@brainstrike/host-lease';
import { createUtilityParentInbox, loadUtilityStartup } from './utility-parent-inbox';

/** BST-2239 proof only: the packaged Windows utility's stderr never reaches the harness. */
function proofEntryTiming(msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ...fields, msg, pid: process.pid, time: new Date().toISOString() });
  process.stderr.write(`${line}\n`);
  const userData = process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];
  if (userData) {
    appendFileSync(join(userData, 'logs', 'agent-host-timing.ndjson'), `${line}\n`);
  }
}

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
    // BST-2239 proof only: the exit flushes Node's compile cache anyway; flushing it here first
    // times that same write, so the exit itself has nothing left to persist.
    proofEntryTiming('BST-2239 host kernel returned; flushing compile cache');
    const flushStartedAt = Date.now();
    flushCompileCache();
    proofEntryTiming('BST-2239 host compile cache flushed; utility exiting', {
      elapsedMs: Date.now() - flushStartedAt,
    });
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
