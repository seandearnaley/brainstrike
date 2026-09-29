import { Schema } from 'effect';
import type { RuntimeEnvelopeObjectPayloadBase, RuntimeRequestPayloadBase } from './index.js';

const nonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0)
);
const envelopeBaseSchema = Schema.Struct({
  channel: nonEmptyString,
  requestId: nonEmptyString,
  runtimeId: nonEmptyString,
  type: Schema.Literals(['cancel', 'error', 'progress', 'request', 'result', 'status']),
});
const requestBaseSchema = Schema.Struct({ kind: Schema.String, requestId: nonEmptyString });

type IsExact<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;
type MatchesFields<TLeft, TRight> =
  IsExact<keyof TLeft, keyof TRight> extends true ? IsExact<TLeft, TRight> : false;
const _envelopeTypeMatches = true satisfies MatchesFields<
  typeof envelopeBaseSchema.Type,
  RuntimeEnvelopeObjectPayloadBase
>;
const _requestTypeMatches = true satisfies MatchesFields<
  typeof requestBaseSchema.Type,
  RuntimeRequestPayloadBase<string>
>;
void _envelopeTypeMatches;
void _requestTypeMatches;

const isEnvelopeType = Schema.is(envelopeBaseSchema.fields.type);
const isRequestId = Schema.is(envelopeBaseSchema.fields.requestId);
const isRuntimeId = Schema.is(envelopeBaseSchema.fields.runtimeId);
const isChannel = Schema.is(envelopeBaseSchema.fields.channel);
const isRequestBaseId = Schema.is(requestBaseSchema.fields.requestId);

/** Preserve the legacy error order and array-root acceptance at this shared boundary. */
export function assertRuntimeObjectPayloadEnvelope(
  value: unknown,
  context: string
): {
  readonly candidate: Record<string, unknown>;
  readonly envelopeBase: RuntimeEnvelopeObjectPayloadBase;
  readonly payload: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object') {
    throw new Error(`${context} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  const type = candidate['type'];
  if (!isEnvelopeType(type)) {
    throw new Error(`${context} must include a valid runtime envelope type.`);
  }
  const requestId = candidate['requestId'];
  if (!isRequestId(requestId)) {
    throw new Error(`${context} must include a non-empty requestId.`);
  }
  const runtimeId = candidate['runtimeId'];
  if (!isRuntimeId(runtimeId)) {
    throw new Error(`${context} must include a non-empty runtimeId.`);
  }
  const channel = candidate['channel'];
  if (!isChannel(channel)) {
    throw new Error(`${context} must include a non-empty channel.`);
  }
  const payload = candidate['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${context} must include a payload object.`);
  }
  return {
    candidate,
    envelopeBase: { channel, requestId, runtimeId, type },
    payload: payload as Record<string, unknown>,
  };
}

export function assertRuntimeRequestPayloadBase<TKind extends string>(
  value: unknown,
  context: string,
  expectedKind: TKind
): {
  readonly candidate: Record<string, unknown>;
  readonly requestBase: RuntimeRequestPayloadBase<TKind>;
} {
  if (!value || typeof value !== 'object') {
    throw new Error(`${context} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['kind'] !== expectedKind) {
    throw new Error(`${context} must declare kind="${expectedKind}".`);
  }
  const requestId = candidate['requestId'];
  if (!isRequestBaseId(requestId)) {
    throw new Error(`${context} must include a non-empty requestId.`);
  }
  return { candidate, requestBase: { kind: expectedKind, requestId } };
}
