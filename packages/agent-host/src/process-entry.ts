import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decodeStartOptions,
  type HostStartOptions,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { ForeignLockError, RootLockedError } from '@brainstrike/state-store';
import { z } from 'zod';
import type { HostPlatform } from './ports.js';
import { startAgentHost } from './runtime.js';

export type HostPlatformFactory = (
  options: HostStartOptions
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
  options: HostStartOptions
): Promise<HostPlatform> {
  const module: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!(module && typeof module === 'object' && 'createHostPlatform' in module)) {
    throw new Error('Configured host module must export createHostPlatform');
  }
  const factory = Factory.parse(module.createHostPlatform);
  return Platform.parse(await factory(options));
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
  const options = decodeStartOptions(JSON.parse(args[0] ?? 'null'));
  const modulePath = args[1];
  if (!modulePath) {
    throw new Error('A configured host platform module is required');
  }
  if (args[2] !== undefined && args[2] !== 'stdio') {
    throw new Error('Unknown host transport');
  }
  const host = await startAgentHost(options, () => loadHostPlatform(modulePath, options));
  let bridge: Socket | undefined;
  const stop = (): void => {
    void host.close().catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (args[2] === 'stdio') {
      bridge = new Socket();
      const socket = bridge;
      socket.on('error', stop);
      await new Promise<void>((done, reject) => {
        socket.once('connect', done);
        socket.once('error', reject);
        socket.connect(host.record.endpoint);
      });
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    }
    await report({ event: 'ready' });
    await host.closed;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    bridge?.destroy();
    process.stdin.unpipe();
    process.stdin.pause();
    await host.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentHostProcess(process.argv.slice(2)).catch(async (cause: unknown) => {
    process.exitCode = 1;
    const message = cause instanceof Error ? cause.message : String(cause);
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
      });
    } catch (reportCause) {
      process.stderr.write(`Host failure report failed: ${String(reportCause)}\n`);
    }
    process.stderr.write(`${message}\n`);
  });
}
