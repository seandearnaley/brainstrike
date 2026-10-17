import {
  strictWireSchema,
  wireResultDecoder,
} from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

interface LifetimePort {
  on(event: 'close', listener: () => void): unknown;
  start(): void;
}
const Message = Schema.Struct({
  data: strictWireSchema(Schema.Struct({ event: Schema.Literal('lifetime') })),
  ports: Schema.mutable(
    Schema.Array(
      Schema.declare<LifetimePort>(
        (value): value is LifetimePort =>
          typeof value === 'object' &&
          value !== null &&
          'on' in value &&
          typeof value.on === 'function' &&
          'start' in value &&
          typeof value.start === 'function'
      )
    )
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
});

/** True when `input` was Main's lifetime port, whose close now runs `lost`. */
export function installHostLifetimePort(input: unknown, lost: () => void): boolean {
  const message = wireResultDecoder(Message, { errors: 'all' })(input);
  if (!(message._tag === 'Success')) {
    return false;
  }
  const port = message.success.ports[0];
  if (!port) {
    throw new Error('Host lifetime message has no transferred port');
  }
  port.on('close', lost);
  port.start();
  return true;
}
