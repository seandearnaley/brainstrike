import { createRequire } from 'node:module';
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
import {
  type HostPlatformLaunchOptions,
  HostPlatformLaunchOptionsSchema,
} from './platform-launch-options.js';
import type { HostPlatform } from './ports.js';
import { isProcessEntrypoint } from './process-entrypoint.js';
import { type AgentHost, type HostStartupContext, startAgentHost } from './runtime.js';

export type HostPlatformFactory = (
  options: HostStartOptions,
  context: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
) => HostPlatform | Promise<HostPlatform>;

/** Launcher control only; client commands still use the authenticated JSON-RPC schema. */
export interface HostProcessParent {
  listen(cancel: () => void): () => void;
  report(message: StartupMessage): Promise<void>;
  /** The launching parent may bind private client transports once Core is open. */
  started?(host: AgentHost): void;
}

const Factory = z.custom<HostPlatformFactory>((value: unknown) => typeof value === 'function');
const Platform = z.custom<HostPlatform>((value: unknown) => {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  return (
    'close' in value &&
    typeof value.close === 'function' &&
    'readPermissionPolicy' in value &&
    typeof value.readPermissionPolicy === 'function' &&
    (('admitRun' in value && typeof value.admitRun === 'function') ||
      ('resolveModel' in value &&
        typeof value.resolveModel === 'function' &&
        'tools' in value &&
        value.tools !== null &&
        typeof value.tools === 'object' &&
        'maxSteps' in value &&
        typeof value.maxSteps === 'number' &&
        Number.isSafeInteger(value.maxSteps) &&
        value.maxSteps > 0))
  );
});

/** Explicit trusted composition module. Its credentials/capabilities stay in this process. */
export async function loadHostPlatform(
  modulePath: string,
  options: HostStartOptions,
  context: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  const module: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!(module && typeof module === 'object' && 'createHostPlatform' in module)) {
    throw new Error('Configured host module must export createHostPlatform');
  }
  const factory = Factory.parse(module.createHostPlatform);
  return Platform.parse(await factory(options, context, platformOptions));
}

async function report(message: StartupMessage): Promise<void> {
  if (!(process.send && process.connected)) {
    return;
  }
  await new Promise<void>((done, reject) => {
    process.send?.(message, (error: Error | null) => (error ? reject(error) : done()));
  });
}

async function reportProcessFailures(
  failures: readonly unknown[],
  root: string | undefined,
  publish: (message: StartupMessage) => Promise<void>
): Promise<void> {
  const causes = [...new Set(failures)];
  if (causes.length === 0) {
    return;
  }
  const cause =
    causes.length === 1 ? causes[0] : new AggregateError(causes, 'Host process and cleanup failed');
  const owner = root ? RootLock.inspect(root)?.owner : undefined;
  const retained =
    owner &&
    !owner.released &&
    owner.pid === process.pid &&
    processStartTime(process.pid) === owner.start;
  try {
    await publish({
      event: 'failed',
      kind:
        cause instanceof RootLockedError
          ? 'root-locked'
          : cause instanceof ForeignLockError
            ? 'foreign-lock'
            : 'error',
      message: cause instanceof Error ? cause.message : String(cause),
      ownership: retained ? 'retained' : 'released',
    });
  } catch (reportCause) {
    process.stderr.write(`Host failure report failed: ${String(reportCause)}\n`);
  }
  throw cause;
}

/** The same Node entry serves socket clients and an optional transparent stdio transport. */
export async function runAgentHostProcess(
  args: readonly string[],
  parent?: HostProcessParent
): Promise<void> {
  // Canonical tools and MCP use the shared logger. Stdout belongs exclusively
  // to JSON-RPC framing; configure before dynamically importing the platform.
  configureLogger({ console: { destination: 2 } });
  if (process.platform === 'win32') {
    // ADR-0017: Windows has no inheritable Root lock. Before this host starts any
    // native process it joins a kill-on-close Job, which ends them all when it exits.
    (
      createRequire(import.meta.url)(
        '@brainstrike/windows-job-native'
      ) as typeof import('@brainstrike/windows-job-native')
    ).initialize();
  }
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
  const releaseParent = parent?.listen(stop);
  const publish = parent?.report.bind(parent) ?? report;
  let bridge: Socket | undefined;
  let root: string | undefined;
  const failures: unknown[] = [];
  try {
    const options = decodeStartOptions(JSON.parse(args[0] ?? 'null'));
    root = options.root;
    const modulePath = args[1];
    if (!modulePath) {
      throw new Error('A configured host platform module is required');
    }
    const stdio = args[2] === 'stdio';
    const privateArgs = args.slice(stdio ? 3 : 2);
    if (
      privateArgs.length > 0 &&
      !(privateArgs.length === 2 && privateArgs[0] === '--platform-options')
    ) {
      throw new Error('Unknown host transport');
    }
    const platformOptions =
      privateArgs.length === 0
        ? undefined
        : HostPlatformLaunchOptionsSchema.parse(JSON.parse(privateArgs[1] ?? 'null'));
    host = await startAgentHost(
      options,
      (context) => loadHostPlatform(modulePath, options, context, platformOptions),
      controller.signal
    );
    const acquired = host;
    if (stdio) {
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
    parent?.started?.(acquired);
    ready = true;
    await publish({ event: 'ready' });
    await host.closed;
  } catch (cause) {
    failures.push(cause);
  } finally {
    if (bridge) {
      bridge.destroy();
      process.stdin.unpipe();
      process.stdin.pause();
    }
    try {
      await host?.close();
    } catch (cause) {
      failures.push(cause);
    } finally {
      const owner = root ? RootLock.inspect(root)?.owner : undefined;
      if (!(owner && !owner.released && owner.pid === process.pid)) {
        releaseParent?.();
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        process.off('message', cancelled);
        process.off('disconnect', disconnected);
      }
    }
  }
  await reportProcessFailures(failures, root, publish);
}

if (isProcessEntrypoint(import.meta.url)) {
  runAgentHostProcess(process.argv.slice(2)).catch((cause: unknown) => {
    process.exitCode = 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${message}\n`);
  });
}
