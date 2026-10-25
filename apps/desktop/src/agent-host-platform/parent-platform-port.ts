import type { PlatformMessagePort } from './connection';

const key = Symbol.for('brainstrike.agent-host.desktop-platform-port');
interface PlatformProcess extends NodeJS.Process {
  [key]?: ReturnType<typeof Promise.withResolvers<PlatformMessagePort>>;
}
function deferred(): ReturnType<typeof Promise.withResolvers<PlatformMessagePort>> {
  const owner: PlatformProcess = process;
  owner[key] ??= Promise.withResolvers<PlatformMessagePort>();
  return owner[key];
}
/**
 * Main's platform channel, opened on the host's stdio before the host opens. The separate
 * bundle and host entry share one process-local capability, never a durable ID.
 */
export function installParentPlatformPort(port: PlatformMessagePort): void {
  deferred().resolve(port);
}
/** Each platform consumes the one port installed for it; a later install starts a new slot. */
export function parentPlatformPort(): Promise<PlatformMessagePort> {
  const owner: PlatformProcess = process;
  const slot = deferred();
  return slot.promise.then((port) => {
    if (owner[key] === slot) {
      delete owner[key];
    }
    return port;
  });
}
