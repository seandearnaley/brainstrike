import type { AgentHost } from '@brainstrike/agent-host';
import {
  strictWireSchema,
  wireResultDecoder,
} from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import { mainPlatformConnection, PlatformMessagePortSchema } from './connection';

const Message = Schema.Struct({
  data: strictWireSchema(Schema.Struct({ event: Schema.Literal('client-port') })),
  ports: Schema.mutable(Schema.Array(PlatformMessagePortSchema)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1)
  ),
});

/**
 * A client port only the launching desktop can hand over, on its private
 * parent channel. It is the visible-UI origin; the public socket never is.
 * Returns false for any other parent message.
 */
export function bindDesktopClientPort(input: unknown, host: AgentHost | undefined): boolean {
  const message = wireResultDecoder(Message, { errors: 'all' })(input);
  if (!(message._tag === 'Success')) {
    return false;
  }
  const port = message.success.ports[0];
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
