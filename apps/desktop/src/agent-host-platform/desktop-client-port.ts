import type { AgentHost } from '@brainstrike/agent-host';
import { z } from 'zod';
import { mainPlatformConnection, type PlatformMessagePort } from './connection';

const Message = z.object({
  data: z.strictObject({ event: z.literal('client-port') }),
  ports: z
    .array(
      z.custom<PlatformMessagePort>(
        (value) =>
          typeof value === 'object' && value !== null && 'postMessage' in value && 'on' in value
      )
    )
    .length(1),
});

/**
 * A client port only the launching desktop can hand over, on its private
 * parent channel. It is the visible-UI origin; the public socket never is.
 * Returns false for any other parent message.
 */
export function bindDesktopClientPort(input: unknown, host: AgentHost | undefined): boolean {
  const message = Message.safeParse(input);
  if (!message.success) {
    return false;
  }
  const port = message.data.ports[0];
  if (!port) {
    throw new Error('Desktop client message has no transferred port');
  }
  if (!host) {
    // Main hands ports over only after readiness; closing tells its relay.
    port.close();
    return true;
  }
  host.bindClientConnection(mainPlatformConnection(port), 'desktop-ui');
  return true;
}
