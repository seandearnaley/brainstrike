import {
  strictWireSchema,
  wireResultDecoder,
} from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import type { PlatformMessagePort } from './connection';
import { PlatformMessagePortSchema } from './connection';

const Message = Schema.Struct({
  data: strictWireSchema(Schema.Struct({ event: Schema.Literal('platform-capabilities') })),
  ports: Schema.mutable(Schema.Array(PlatformMessagePortSchema)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1)
  ),
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
  const message = wireResultDecoder(Message, { errors: 'all' })(input);
  if (!(message._tag === 'Success')) {
    return false;
  }
  const port = message.success.ports[0];
  if (!port) {
    throw new Error('Desktop platform message has no transferred port');
  }
  deferred().resolve(port);
  return true;
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
