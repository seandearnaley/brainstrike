import { z } from 'zod';
import type { PlatformMessagePort } from './connection';

const Message = z.object({
  data: z.strictObject({ event: z.literal('platform-capabilities') }),
  ports: z
    .array(
      z.custom<PlatformMessagePort>(
        (value) =>
          typeof value === 'object' && value !== null && 'postMessage' in value && 'on' in value
      )
    )
    .length(1),
});
const key = Symbol.for('brainstrike.agent-host.desktop-platform-port');
interface PlatformProcess extends NodeJS.Process {
  [key]?: ReturnType<typeof Promise.withResolvers<PlatformMessagePort>>;
}
function deferred(): ReturnType<typeof Promise.withResolvers<PlatformMessagePort>> {
  const owner: PlatformProcess = process;
  owner[key] ??= Promise.withResolvers<PlatformMessagePort>();
  return owner[key];
}
/** The separate bundle and utility entry share one process-local capability, never a durable ID. */
export function installParentPlatformPort(input: unknown): boolean {
  const message = Message.safeParse(input);
  if (!message.success) {
    return false;
  }
  const port = message.data.ports[0];
  if (!port) {
    throw new Error('Desktop platform message has no transferred port');
  }
  deferred().resolve(port);
  return true;
}
export function parentPlatformPort(): Promise<PlatformMessagePort> {
  return deferred().promise;
}
