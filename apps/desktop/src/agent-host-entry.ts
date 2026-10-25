// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';
import { enableCompileCache } from 'node:module';
import type { OpenedAgentHost } from '@brainstrike/agent-host';
import { configureLogger } from '@brainstrike/logging';
import { bindDesktopClientPort } from './agent-host-platform/desktop-client-port';
import { installParentPlatformPort } from './agent-host-platform/parent-platform-port';
import {
  decodeHostChildArgs,
  decodeHostChildControl,
  type HostChildMessage,
} from './host-child-messages';
import { openHostStdio } from './host-stdio';
import { lifecycleDelay, takeLifecycleDelays } from './lifecycle-delays';

/**
 * The agent host as a headless program, as `codex app-server` is Codex Desktop's: it
 * runs under plain Node or Electron's Node, speaks JSON-RPC on stdin and stdout, and
 * closes when its client asks or its stdin ends. It opens the profile's root, reports `ready` once, and
 * serves each channel its client opens: Main's platform first, then each client.
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
  // Only Main's spawn env carries it (the E2E seam); removed so no host descendant inherits it.
  const lifecycleDelays = takeLifecycleDelays();
  const controller = new AbortController();
  let host: OpenedAgentHost | undefined;
  let exiting = false;
  const exit = (code: number): void => {
    exiting = true;
    process.exit(code);
  };
  const failed = (cause: unknown): void => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  };
  const close = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    controller.abort(new Error('Host process closed'));
    if (!host) {
      process.exit(0);
    }
    host.close().then(
      () => process.exit(0),
      (cause: unknown) => {
        failed(cause);
        process.exit(1);
      }
    );
  };
  const stdio = openHostStdio(process.stdin, process.stdout, {
    invalid: (cause) => {
      failed(cause);
      close();
    },
    message: (input) => {
      try {
        if (decodeHostChildControl(input).method === 'close') {
          close();
          return;
        }
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
  // stdin's end is the client gone: this host closes without it.
  void stdio.ended.then(close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try {
    const { modulePath, platformOptions, root } = decodeHostChildArgs(process.argv.slice(2));
    const { openHostProcess } = await import('@brainstrike/agent-host');
    host = await openHostProcess(root, modulePath, platformOptions, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    await lifecycleDelay(lifecycleDelays, 'host-ready');
    await report({ event: 'ready' });
  } catch (cause) {
    if (controller.signal.aborted) {
      return;
    }
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
