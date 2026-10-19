/**
 * Messages between Main and the agent egress utility process (BST-1238).
 * Main starts the proxy with a per-launch credential; the utility answers
 * `ready` with its port, or `failed`, and reports each refusal. BST-1178: Main
 * then sets the loopback servers agent tabs may reach, and the utility
 * answers each revision once the proxy admits it.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { REFUSED_ADDRESS_CLASSES } from './address-policy';

const StartSchema = Schema.Struct({
  credential: Schema.String,
  type: Schema.Literal('start'),
});
const LoopbackSchema = Schema.Struct({
  authorities: Schema.Array(Schema.String),
  revision: Schema.Number,
  type: Schema.Literal('loopback'),
});
const CommandSchema = Schema.Union([StartSchema, LoopbackSchema]);
export type EgressCommand = typeof CommandSchema.Type;
export const decodeEgressCommand = makeThrowingDecoder(CommandSchema, {
  onExcessProperty: 'error',
});

const RefusalSchema = Schema.Union([
  Schema.Struct({
    address: Schema.String,
    addressClass: Schema.Literals(REFUSED_ADDRESS_CLASSES),
    host: Schema.String,
    reason: Schema.Literal('destination'),
  }),
  Schema.Struct({ host: Schema.String, reason: Schema.Literal('unresolved') }),
  Schema.Struct({ reason: Schema.Literal('malformed'), target: Schema.String }),
]);

const EventSchema = Schema.Union([
  Schema.Struct({ port: Schema.Number, type: Schema.Literal('ready') }),
  Schema.Struct({ message: Schema.String, type: Schema.Literal('failed') }),
  Schema.Struct({ refusal: RefusalSchema, type: Schema.Literal('refusal') }),
  Schema.Struct({ revision: Schema.Number, type: Schema.Literal('loopback-admitted') }),
  Schema.Struct({
    message: Schema.String,
    revision: Schema.Number,
    type: Schema.Literal('loopback-refused'),
  }),
]);
export type EgressEvent = typeof EventSchema.Type;
export const decodeEgressEvent = makeThrowingDecoder(EventSchema, { onExcessProperty: 'error' });
