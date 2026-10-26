// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';
import { enableCompileCache } from 'node:module';
import type { OpenedAgentHost } from '@brainstrike/agent-host';
import { configureLogger } from '@brainstrike/logging';
import { onProcessGroup } from '@brainstrike/utils/process-groups';
import { bindDesktopClientPort } from './agent-host-platform/desktop-client-port';
import { installParentPlatformPort } from './agent-host-platform/parent-platform-port';
import {
  decodeHostChildArgs,
  decodeHostChildControl,
  type HostChildMessage,
} from './host-child-messages';
import { openHostStdio } from './host-stdio';

/**
 * The agent host as a headless program, as `codex app-server` is Codex Desktop's: it
 * runs under plain Node or Electron's Node, speaks JSON-RPC on stdin and stdout, and
 * closes when its stdin ends, without its client. It opens the profile's root, reports `ready`
 * once, and serves each channel its client opens: Main's platform first, then each client.
 * Every write is already committed, so a client killing it loses nothing.
 */
async function main(): Promise<void> {
  // Node's on-disk compile cache, on before the host's module graph loads (the
  // dynamic imports below), as the CLI does. Worker threads enable their own.
  // https://nodejs.org/api/module.html#moduleenablecompilecacheoptions
  enableCompileCache();
  // stdout carries only the protocol; this process's log goes to stderr.
  configureLogger({ console: { destination: 2 }, includeTimestamp: true });
  // Electron's Node runs this entry as Node; nothing this host starts inherits that.
  Reflect.deleteProperty(process.env, 'ELECTRON_RUN_AS_NODE');
  let host: OpenedAgentHost | undefined;
  let exiting = false;
  const exit = (code: number): void => {
    exiting = true;
    process.exit(code);
  };
  const failed = (cause: unknown): void => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  };
  // ADR-0031: the client gone is the whole ask. Every write is committed when it is made, so
  // the host exits at once and joins nothing: the OS releases the Root, and the client ends
  // what the host started (its kill-on-close Job, the command groups it was told of).
  const close = (): void => {
    if (!exiting) {
      exit(0);
    }
  };
  const stdio = openHostStdio(process.stdin, process.stdout, {
    invalid: (cause) => {
      failed(cause);
      close();
    },
    message: (input) => {
      try {
        decodeHostChildControl(input);
        if (!host) {
          throw new Error('Content clear requires a ready host');
        }
        // A content clear closes the host when its deletion has committed; the receipt
        // is written before the process exits.
        exiting = true;
        host.clearAndRetireContent().then(
          (receipt) => report({ event: 'content-cleared', ...receipt }).then(() => exit(0)),
          (cause: unknown) => {
            failed(cause);
            exit(1);
          }
        );
      } catch (cause) {
        failed(cause);
        close();
      }
    },
    opened: (channel, port) => {
      if (channel === 'platform') {
        installParentPlatformPort(port);
      } else {
        bindDesktopClientPort(port, host);
      }
    },
  });
  const report = (message: HostChildMessage): Promise<void> => stdio.message(message);
  // Every command group this host starts, so its client can end any this host leaves behind.
  onProcessGroup((group) => {
    report({ event: 'command-group', ...group }).catch(failed);
  });
  // stdin's end is the client gone: this host closes without it.
  void stdio.ended.then(close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try {
    const { modulePath, platformOptions, root } = decodeHostChildArgs(process.argv.slice(2));
    const { openHostProcess } = await import('@brainstrike/agent-host');
    // Nothing cancels the opening: the client's end exits this process instead.
    host = await openHostProcess(root, modulePath, platformOptions, new AbortController().signal);
    await report({ event: 'ready' });
  } catch (cause) {
    const { RootLockedError } = await import('@brainstrike/state-store');
    failed(cause);
    await report({
      event: 'failed',
      kind: cause instanceof RootLockedError ? 'root-locked' : 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => undefined);
    exit(1);
  }
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exit(1);
});
