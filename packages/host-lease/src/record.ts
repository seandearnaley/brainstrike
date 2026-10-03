import { timingSafeEqual } from 'node:crypto';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

export const PROTOCOL_VERSION = 1;
export const HOST_VERSION = '0.1.0';
export const HOST_RECORD_FILE = 'host.json';
const PositiveInt = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);
const Nonempty = Schema.String.check(Schema.isPattern(/^.{1,256}$/));
const Token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Endpoint = Schema.String.check(
  Schema.isPattern(/^(?:\/[^\r\n\0]+|\\\\\.\\pipe\\brainstrike-[a-f0-9]+)$/)
);

export const HostRecordSchema = Schema.Struct({
  endpoint: Endpoint,
  hostVersion: Nonempty,
  pid: PositiveInt,
  protocolVersion: PositiveInt,
  start: Nonempty,
  token: Token,
});
export type HostRecord = typeof HostRecordSchema.Type;
export const decodeHostRecord = makeThrowingDecoder(HostRecordSchema, {
  onExcessProperty: 'error',
});
const decodeToken = makeThrowingDecoder(Token);

export function tokensEqual(expected: string, actual: string): boolean {
  return timingSafeEqual(
    Buffer.from(decodeToken(expected), 'hex'),
    Buffer.from(decodeToken(actual), 'hex')
  );
}

export const RequestSchema = Schema.Union([
  Schema.Struct({
    hostVersion: Nonempty,
    method: Schema.Literal('initialize'),
    protocolVersion: PositiveInt,
    token: Token,
  }),
  Schema.Struct({ method: Schema.Literal('attach') }),
]);
export type HostRequest = typeof RequestSchema.Type;
export const decodeRequest = makeThrowingDecoder(RequestSchema, { onExcessProperty: 'error' });
export const ReplySchema = Schema.Union([
  Schema.Struct({
    hostVersion: Nonempty,
    method: Schema.Literal('initialized'),
    pid: PositiveInt,
    protocolVersion: PositiveInt,
    start: Nonempty,
  }),
  Schema.Struct({ method: Schema.Literal('attached') }),
  Schema.Struct({ message: Nonempty, method: Schema.Literal('error') }),
]);
export type HostReply = typeof ReplySchema.Type;
export const decodeReply = makeThrowingDecoder(ReplySchema, { onExcessProperty: 'error' });
