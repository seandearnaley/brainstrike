import { type AgentHost, runAgentHostProcess } from '@brainstrike/agent-host';
import type { StartupMessage } from '@brainstrike/host-lease';
import { bindDesktopClientPort } from './agent-host-platform/desktop-client-port';
import { installParentPlatformPort } from './agent-host-platform/parent-platform-port';
import { decodeHostLeaseControl, decodeHostLeaseParentMessage } from './host-lease-control';
import { installHostLifetimePort } from './host-lifetime-port';

/** Electron provides a launcher channel; all agent work stays in the Node kernel. */
async function main(): Promise<void> {
  const parent = process.parentPort;
  if (!parent) {
    throw new Error('Agent host utility has no parent channel');
  }
  let retained = false;
  let controlFailure: unknown;
  let host: AgentHost | undefined;
  try {
    await runAgentHostProcess(process.argv.slice(2), {
      listen: (cancel) => {
        const receive = (input: unknown): void => {
          try {
            if (
              installParentPlatformPort(input) ||
              installHostLifetimePort(input, cancel) ||
              bindDesktopClientPort(input, host)
            ) {
              return;
            }
            decodeHostLeaseControl(decodeHostLeaseParentMessage(input).data);
          } catch (cause) {
            controlFailure ??= cause;
          }
          cancel();
        };
        parent.on('message', receive);
        return () => parent.off('message', receive);
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
    // The private parent channel remains referenced after a successful join.
    process.exit(0);
  } catch (cause) {
    process.exitCode = 1;
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    // Failed physical joins retain the real writer/root. The parent close
    // barrier reports its unchanged deadline instead of killing that owner.
    if (!retained) {
      process.exit(1);
    }
  }
}

void main().catch((cause: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`${String(cause)}\n`);
});
