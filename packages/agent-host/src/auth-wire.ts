import { omitUndefinedOptional } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

const HostAuthStatusWire = Schema.Union(
  [
    Schema.Struct({ state: Schema.Literal('disconnected') }),
    Schema.Struct({ state: Schema.Literal('connecting') }),
    Schema.Struct({ state: Schema.Literal('awaiting_browser') }),
    Schema.Struct({
      state: Schema.Literal('awaiting_device_code'),
      userCode: Schema.String,
      verificationUri: Schema.String,
    }),
    Schema.Struct({
      accountId: omitUndefinedOptional(Schema.String),
      state: Schema.Literal('connected'),
    }),
    Schema.Struct({
      code: Schema.Literals([
        'browser_open_failed',
        'callback_timeout',
        'credential_persist_failed',
        'credential_unreadable',
        'device_flow_denied',
        'device_flow_expired',
        'device_flow_failed',
        'device_flow_unsupported',
        'flow_already_active',
        'flow_failed',
        'port_in_use',
        'refresh_token_missing',
        'token_exchange_failed',
        'unknown_provider',
      ]),
      state: Schema.Literal('error'),
    }),
    Schema.Struct({ state: Schema.Literal('reconnect_required') }),
  ],
  { mode: 'oneOf' }
);
/** Token-free provider OAuth status; the only payload `auth/*` flow methods return. */
export const HostAuthStatusSchema = HostAuthStatusWire;
/** A subscription session's liveness verdict; the access token never leaves the host. */
export const HostAuthVerdictSchema = Schema.Union(
  [
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({
      ok: Schema.Literal(false),
      status: Schema.Literals(['not_connected', 'reconnect_required']),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostAuthVerdict = (typeof HostAuthVerdictSchema)['Type'];
