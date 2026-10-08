import type { ProviderAuthStatus } from '@brainstrike/assistant-contract';
import { z } from 'zod';

const HostAuthStatusWire = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('disconnected') }),
  z.strictObject({ state: z.literal('connecting') }),
  z.strictObject({ state: z.literal('awaiting_browser') }),
  z.strictObject({
    state: z.literal('awaiting_device_code'),
    userCode: z.string(),
    verificationUri: z.string(),
  }),
  z.strictObject({ accountId: z.string().optional(), state: z.literal('connected') }),
  z.strictObject({
    code: z.enum([
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
    state: z.literal('error'),
  }),
  z.strictObject({ state: z.literal('reconnect_required') }),
]);

function providerAuthStatus(status: z.output<typeof HostAuthStatusWire>): ProviderAuthStatus {
  if (status.state !== 'connected') {
    return status;
  }
  return status.accountId === undefined
    ? { state: 'connected' }
    : { accountId: status.accountId, state: 'connected' };
}

/** Token-free provider OAuth status; the only payload `auth/*` flow methods return. */
export const HostAuthStatusSchema = HostAuthStatusWire.transform(providerAuthStatus);

/** A subscription session's liveness verdict; the access token never leaves the host. */
export const HostAuthVerdictSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    status: z.enum(['not_connected', 'reconnect_required']),
  }),
]);
export type HostAuthVerdict = z.output<typeof HostAuthVerdictSchema>;
