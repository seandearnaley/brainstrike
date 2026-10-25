import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { HostPlatformLaunchOptions } from './platform-launch-options.ts';
import type { HostPlatform } from './ports.ts';
import { type HostStartupContext, type OpenedAgentHost, openAgentHost } from './runtime.ts';
import { startHostTracing } from './telemetry/otel.ts';

/** The data root a platform module composes its host for. */
export interface HostPlatformRoot {
  readonly root: string;
}
export type HostPlatformFactory = (
  options: HostPlatformRoot,
  context: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
) => HostPlatform | Promise<HostPlatform>;
const Factory = Schema.declare(
  (value: unknown): value is HostPlatformFactory => typeof value === 'function'
);
const Platform = Schema.declare((value: unknown): value is HostPlatform => {
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
  options: HostPlatformRoot,
  context: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  const module: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!(module && typeof module === 'object' && 'createHostPlatform' in module)) {
    throw new Error('Configured host module must export createHostPlatform');
  }
  const factory = Schema.decodeUnknownSync(Factory, { errors: 'all', onExcessProperty: 'error' })(
    module.createHostPlatform
  );
  return Schema.decodeSync(Platform, { errors: 'all', onExcessProperty: 'error' })(
    await factory(options, context, platformOptions)
  );
}
/** ADR-0017: every native process this one starts ends when it exits (Windows: a kill-on-close Job). */
function joinKillOnCloseJob(): void {
  if (process.platform === 'win32') {
    (
      createRequire(import.meta.url)(
        '@brainstrike/windows-job-native'
      ) as typeof import('@brainstrike/windows-job-native')
    ).initialize();
  }
}
/**
 * The desktop's host child: the platform module's host over `root`, with this
 * process's logging, tracing and kill-on-close Job. Closing it closes the host,
 * then flushes its spans.
 */
export async function openHostProcess(
  root: string,
  modulePath: string,
  platformOptions: HostPlatformLaunchOptions | undefined,
  signal: AbortSignal
): Promise<OpenedAgentHost> {
  configureLogger({ console: { destination: 2 }, includeTimestamp: true });
  joinKillOnCloseJob();
  // Before the platform loads: a misconfigured exporter fails startup visibly.
  const tracing = await startHostTracing(process.env);
  let host: OpenedAgentHost;
  try {
    host = await openAgentHost(
      root,
      (context) => loadHostPlatform(modulePath, { root }, context, platformOptions),
      signal
    );
  } catch (cause) {
    await tracing?.shutdown().catch(() => undefined);
    throw cause;
  }
  let closing: Promise<void> | undefined;
  return {
    ...host,
    close: () => {
      closing ??= host.close().finally(() => tracing?.shutdown());
      return closing;
    },
  };
}
