// biome-ignore-all lint/style/useNamingConvention: canonical MCP conformance and OAuth wire fields use snake_case.

import {
  OFFICIAL_AUTH_BASELINE_SCENARIOS,
  OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS,
  OFFICIAL_AUTH_SCENARIOS,
  type OfficialAuthScenarioName,
} from '@brainstrike/assistant-contract/official-auth-conformance';
import type { StoredOAuthClientInformation } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { DesktopMcpHostRuntimeDependencies } from './host-runtime';
import { createInMemoryMcpOAuthStore, createMcpOAuthClientProvider } from './oauth-client-provider';

const NonEmpty = z.string().min(1);
const CIMD_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';
export const OFFICIAL_AUTH_SCENARIO_NAMES = OFFICIAL_AUTH_BASELINE_SCENARIOS;
export const MODERN_ONLY_OFFICIAL_AUTH_SCENARIO_NAMES = OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS;
export type { OfficialAuthScenarioName };
export const BaselineOfficialAuthScenarioNameSchema = z.enum(OFFICIAL_AUTH_BASELINE_SCENARIOS);
export const AllOfficialAuthScenarioNameSchema = z.enum(OFFICIAL_AUTH_SCENARIOS);
export const ModernOnlyOfficialAuthScenarioNameSchema = z.enum(
  MODERN_ONLY_OFFICIAL_AUTH_SCENARIO_NAMES
);
const OfficialConformanceOAuthContextSchema = z.discriminatedUnion('name', [
  z.strictObject({
    client_id: NonEmpty,
    name: z.literal('auth/client-credentials-jwt'),
    private_key_pem: NonEmpty,
    signing_algorithm: NonEmpty.optional(),
  }),
  z.strictObject({
    client_id: NonEmpty,
    client_secret: NonEmpty,
    name: z.literal('auth/client-credentials-basic'),
  }),
  z.strictObject({
    client_id: NonEmpty,
    client_secret: NonEmpty,
    name: z.literal('auth/pre-registration'),
  }),
  z.strictObject({
    client_id: NonEmpty,
    client_secret: NonEmpty,
    idp_client_id: NonEmpty,
    idp_id_token: NonEmpty,
    idp_issuer: NonEmpty,
    idp_token_endpoint: NonEmpty,
    name: z.literal('auth/enterprise-managed-authorization'),
  }),
  z.strictObject({
    client_id: NonEmpty,
    expired_jwt: NonEmpty,
    name: z.literal('auth/wif-jwt-bearer'),
    valid_jwt: NonEmpty,
    wrong_audience_jwt: NonEmpty,
  }),
]);

export type OfficialConformanceOAuthContext = z.output<
  typeof OfficialConformanceOAuthContextSchema
>;

export function parseOfficialConformanceOAuthContext(
  raw: string | undefined
): OfficialConformanceOAuthContext | undefined {
  if (raw === undefined) {
    return;
  }
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    throw new Error('Official MCP conformance OAuth context is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Official MCP conformance OAuth context is invalid');
  }
  const result = OfficialConformanceOAuthContextSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Official MCP conformance OAuth context is invalid');
  }
  return result.data;
}

export function parseOfficialAuthScenarioContext(
  scenario: OfficialAuthScenarioName,
  raw: string | undefined
): Extract<OfficialConformanceOAuthContext, { name: 'auth/pre-registration' }> | undefined {
  const context = parseOfficialConformanceOAuthContext(raw);
  if (scenario !== 'auth/pre-registration') {
    if (context !== undefined) {
      throw new Error('Official MCP conformance auth scenario context is invalid');
    }
    return;
  }
  if (context?.name !== 'auth/pre-registration') {
    throw new Error('Official MCP conformance auth scenario context is invalid');
  }
  return context;
}

type OAuthRuntimeDependencies = Pick<
  DesktopMcpHostRuntimeDependencies,
  'createOAuthProvider' | 'oauthStore' | 'openExternal'
>;

export function createEphemeralOfficialConformanceOAuthRuntime(options: {
  readonly context?: string;
  readonly openAuthorization: (url: string) => Promise<void>;
  readonly scenario: OfficialAuthScenarioName;
}): Required<OAuthRuntimeDependencies> {
  const context = parseOfficialAuthScenarioContext(options.scenario, options.context);
  const preRegisteredClient: StoredOAuthClientInformation | undefined = context
    ? {
        client_id: context.client_id,
        client_secret: context.client_secret,
        // alpha.10's pre-registration fixture advertises only client_secret_basic
        // and supplies credentials, not a registered redirect URI. The production
        // provider publishes its live loopback URI through clientMetadata.
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
      }
    : undefined;
  return {
    createOAuthProvider: async (providerOptions) =>
      await createMcpOAuthClientProvider({
        ...providerOptions,
        ...(options.scenario === 'auth/basic-cimd'
          ? { clientMetadataUrl: CIMD_CLIENT_METADATA_URL }
          : {}),
        ...(preRegisteredClient ? { preRegisteredClient } : {}),
      }),
    oauthStore: createInMemoryMcpOAuthStore(),
    openExternal: options.openAuthorization,
  };
}
