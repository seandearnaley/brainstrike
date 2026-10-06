import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodeStartOptions,
  type HostStartOptions,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { configureLogger } from '@brainstrike/logging';
import {
  ForeignLockError,
  processStartTime,
  RootLock,
  RootLockedError,
} from '@brainstrike/state-store';
import { z } from 'zod';
import type { HostPlatform } from './ports.js';
import { isProcessEntrypoint } from './process-entrypoint.js';
import { type AgentHost, type HostStartupContext, startAgentHost } from './runtime.js';

export type HostPlatformFactory = (
  options: HostStartOptions,
  context: HostStartupContext
) => HostPlatform | Promise<HostPlatform>;

const Factory = z.custom<HostPlatformFactory>((value: unknown) => typeof value === 'function');
const Platform = z.custom<HostPlatform>((value: unknown) => {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  return (
    'close' in value &&
    typeof value.close === 'function' &&
    'resolveModel' in value &&
    typeof value.resolveModel === 'function' &&
    'readPermissionPolicy' in value &&
    typeof value.readPermissionPolicy === 'function' &&
    'tools' in value &&
    value.tools !== null &&
    typeof value.tools === 'object' &&
    'maxSteps' in value &&
    typeof value.maxSteps === 'number' &&
    Number.isSafeInteger(value.maxSteps) &&
    value.maxSteps > 0
  );
});

/** Explicit trusted composition module. Its credentials/capabilities stay in this process. */
export async function loadHostPlatform(
  modulePath: string,
  options: HostStartOptions,
  context: HostStartupContext
): Promise<HostPlatform> {
  const module: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!(module && typeof module === 'object' && 'createHostPlatform' in module)) {
    throw new Error('Configured host module must export createHostPlatform');
  }
  const factory = Factory.parse(module.createHostPlatform);
  return Platform.parse(await factory(options, context));
}

async function report(message: StartupMessage): Promise<void> {
  if (!(process.send && process.connected)) {
    return;
  }
  await new Promise<void>((done, reject) => {
    process.send?.(message, (error: Error | null) => (error ? reject(error) : done()));
  });
}

/** The same Node entry serves socket clients and an optional transparent stdio transport. */
export async function runAgentHostProcess(args: readonly string[]): Promise<void> {
  // Canonical tools and MCP use the shared logger. Stdout belongs exclusively
  // to JSON-RPC framing; configure before dynamically importing the platform.
  configureLogger({ console: { destination: 2 } });
  const controller = new AbortController();
  let host: AgentHost | undefined;
  let ready = false;
  const stop = (): void => {
    controller.abort(new Error('Host process cancelled'));
    void host?.close().catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
  };
  const cancelled = (value: unknown): void => {
    if (
      value &&
      typeof value === 'object' &&
      'event' in value &&
      value.event === 'cancel-startup'
    ) {
      stop();
    }
  };
  const disconnected = (): void => {
    if (!ready) {
      stop();
    }
  };
  // Installed before acquiring the root or invoking any platform initializer.
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('message', cancelled);
  process.on('disconnect', disconnected);
  let bridge: Socket | undefined;
  let root: string | undefined;
  try {
    const options = decodeStartOptions(JSON.parse(args[0] ?? 'null'));
    root = options.root;
    const modulePath = args[1];
    if (!modulePath) {
      throw new Error('A configured host platform module is required');
    }
    if (args[2] !== undefined && args[2] !== 'stdio') {
      throw new Error('Unknown host transport');
    }
    host = await startAgentHost(
      options,
      (context) => loadHostPlatform(modulePath, options, context),
      controller.signal
    );
    const acquired = host;
    if (args[2] === 'stdio') {
      bridge = new Socket();
      const socket = bridge;
      socket.on('error', stop);
      await new Promise<void>((done, reject) => {
        socket.once('connect', done);
        socket.once('error', reject);
        socket.connect(acquired.record.endpoint);
      });
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    }
    controller.signal.throwIfAborted();
    ready = true;
    await report({ event: 'ready' });
    await host.closed;
  } finally {
    bridge?.destroy();
    process.stdin.unpipe();
    process.stdin.pause();
    try {
      await host?.close();
    } finally {
      const owner = root ? RootLock.inspect(root)?.owner : undefined;
      if (!(owner && !owner.released && owner.pid === process.pid)) {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        process.off('message', cancelled);
        process.off('disconnect', disconnected);
      }
    }
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  runAgentHostProcess(process.argv.slice(2)).catch(async (cause: unknown) => {
    process.exitCode = 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    const root = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null')).root;
    const owner = RootLock.inspect(root)?.owner;
    const retained =
      owner &&
      !owner.released &&
      owner.pid === process.pid &&
      processStartTime(process.pid) === owner.start;
    try {
      await report({
        event: 'failed',
        kind:
          cause instanceof RootLockedError
            ? 'root-locked'
            : cause instanceof ForeignLockError
              ? 'foreign-lock'
              : 'error',
        message,
        ownership: retained ? 'retained' : 'released',
      });
    } catch (reportCause) {
      process.stderr.write(`Host failure report failed: ${String(reportCause)}\n`);
    }
    process.stderr.write(`${message}\n`);
  });
}
