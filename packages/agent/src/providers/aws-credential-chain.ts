/**
 * AWS default credential chain (BST-1353) — the SECOND valid Bedrock auth
 * form beside phase 1's bearer key. Profiles, SSO, `credential_process`,
 * web-identity/EKS, and instance/container roles all arrive through this one
 * seam, exactly as the AWS CLI resolves them.
 *
 * NODE-ONLY. `@aws-sdk/credential-providers` reads `~/.aws`, spawns
 * `credential_process` children, and talks to IMDS — it must never reach a
 * browser bundle. This module is therefore imported ONLY beside the provider
 * factory (provider-factory.ts) and is listed in tsup's `sharedExternal`;
 * `provider-auth-input.ts` types the seam through the import-free
 * aws-credential-identity.ts instead. Web reaches profile-chain resolution
 * through NO path at all: the assistant-service projection takes the chain
 * factory as an INJECTED capability that only desktop main supplies.
 *
 * ## Installed unconditionally, like the AWS CLI (opencode's V2 philosophy)
 *
 * The chain is NOT gated on explicit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
 * env vars. Gating on them would break every legitimate credential source the
 * chain exists to serve — `~/.aws/credentials`, SSO, process credentials,
 * instance roles. Once profile-chain mode is SELECTED, the full chain runs.
 * (What IS gated is selection itself; see the env-activation rule in
 * apps/desktop/src/provider-api-key.ts.)
 *
 * ## Failure mapping — the class names below were MEASURED, not guessed
 *
 * Chain resolution is LAZY: `@ai-sdk/amazon-bedrock` calls the provider when
 * it signs a request, so a bad profile fails mid-run, not at model
 * construction. Raw SDK text ("Could not load credentials from any
 * providers") is useless to a user, so every rejection is translated here,
 * at the seam that still knows which profile was searched.
 *
 * An empirical probe against `@aws-sdk/credential-providers` 3.1111.0 (bogus
 * HOME + profile dirs; reproduced as the EMPIRICAL block of
 * `src/__tests__/aws-credential-chain.spec.ts`) measured:
 *
 * | scenario                              | error.name                 | message |
 * | ------------------------------------- | -------------------------- | ------- |
 * | no credentials anywhere               | `CredentialsProviderError` | `Could not load credentials from any providers` |
 * | named profile missing                 | `CredentialsProviderError` | `Could not load credentials from any providers` |
 * | profile exists, region only           | `CredentialsProviderError` | `Could not load credentials from any providers` |
 * | SSO token missing/invalid             | `CredentialsProviderError` | `The SSO session token associated with profile=… was not found or is invalid. To refresh this SSO session run 'aws sso login' …` |
 * | SSO cached token expired, no refresh  | `CredentialsProviderError` | `Value not present for 'refreshToken' in SSO Token. Cannot refresh. To refresh this SSO session run 'aws sso login' …` |
 * | SSO cached token expired, refresh 4xx | `CredentialsProviderError` | `Token is expired. To refresh this SSO session run 'aws sso login' …` |
 * | legacy sso profile, no cache          | `CredentialsProviderError` | `The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login …` |
 *
 * Two findings drive the implementation, and BOTH contradict the obvious
 * guess — do not "simplify" this back:
 *
 * 1. There is NO distinct expired-SSO error class. Every failure above is the
 *    single class `CredentialsProviderError`, so the discriminator has to be
 *    the MESSAGE. The stable marker across all four SSO variants is the
 *    substring `sso login` — note the legacy-profile variant writes
 *    `run aws sso login` WITHOUT the surrounding quotes, so matching the
 *    quoted `'aws sso login'` would miss it.
 * 2. That class is not importable here. It is defined in
 *    `@smithy/property-provider`, a transitive package that does not resolve
 *    from `packages/agent` (verified: `ERR_MODULE_NOT_FOUND`). `instanceof`
 *    is therefore unavailable and the check is STRUCTURAL, on `error.name` —
 *    the same technique `matchSecretReadError` uses across the IPC boundary.
 *
 * Anything that is NOT a recognized chain failure is surfaced VERBATIM rather
 * than folded into one of the two known causes (NO SILENT FALLBACKS): a DNS
 * failure during an SSO refresh must not read as "run aws sso login".
 */
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import type { AwsCredentialIdentityProvider } from './aws-credential-identity';

/**
 * Message substring shared by EVERY SSO failure variant the probe produced.
 * Unquoted on purpose (see finding 1 above).
 */
const AWS_SSO_MESSAGE_MARKER = 'sso login';

/** Message the SDK emits when the whole chain came up empty. */
const AWS_NO_CREDENTIALS_MESSAGE = 'Could not load credentials from any providers';

/**
 * Stable, assertable fragment of the no-credentials guidance. Exported so the
 * tests pin the user-visible text instead of re-spelling it.
 */
export const AWS_CHAIN_NO_CREDENTIALS_HINT =
  'No AWS credentials were found by the default credential chain';

/** The name AWS itself uses for a chain run with no explicit profile. */
const DEFAULT_PROFILE_NAME = 'default';

/**
 * Structural check — `instanceof` is impossible here (finding 2). A false
 * positive is harmless: the message match still decides the guidance.
 */
function isCredentialsProviderError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CredentialsProviderError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which recognized cause a chain rejection has. `unknown` is a first-class
 * outcome, not a catch-all to be quietly folded into the others: consumers
 * that map causes to verdicts (the verification probe) must be able to say
 * "no verdict obtainable" instead of asserting a wrong-credential answer.
 */
export type AwsChainFailureKind = 'no_credentials' | 'sso_expired' | 'unknown';

export interface AwsChainFailure {
  readonly detail: string;
  readonly kind: AwsChainFailureKind;
}

/**
 * Classify a chain rejection and render actionable guidance naming the
 * profile actually searched. Exported so the credential-verification probe
 * can map the SAME causes to its own verdicts without re-deriving them.
 */
export function classifyAwsChainFailure(
  error: unknown,
  profile: string | undefined
): AwsChainFailure {
  const profileName = profile ?? DEFAULT_PROFILE_NAME;
  const message = errorMessage(error);

  if (isCredentialsProviderError(error) && message.toLowerCase().includes(AWS_SSO_MESSAGE_MARKER)) {
    return {
      detail: `AWS SSO session expired — run \`aws sso login --profile ${profileName}\` and send the message again.`,
      kind: 'sso_expired',
    };
  }

  if (isCredentialsProviderError(error) && message.includes(AWS_NO_CREDENTIALS_MESSAGE)) {
    return {
      detail: `${AWS_CHAIN_NO_CREDENTIALS_HINT} for profile "${profileName}". Configure it with \`aws configure --profile ${profileName}\`, sign in with \`aws sso login --profile ${profileName}\`, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.`,
      kind: 'no_credentials',
    };
  }

  // Unrecognized: surface the SDK's own text rather than mislabel the cause.
  return {
    detail: `AWS credential resolution failed for profile "${profileName}": ${message}`,
    kind: 'unknown',
  };
}

/**
 * Guidance text only — the common case for callers that just need something
 * actionable to show. `createAwsCredentialChain` is what production request
 * code calls; this and {@link classifyAwsChainFailure} exist for the probe
 * and for direct unit coverage of each branch.
 */
export function describeAwsChainFailure(error: unknown, profile: string | undefined): string {
  return classifyAwsChainFailure(error, profile).detail;
}

/**
 * Resolve the chain purely to VERIFY it (BST-1353 "Test connection"). Unlike
 * the request path this never throws: the caller wants a verdict, so both
 * outcomes come back as data. No network call is involved unless the
 * configured profile itself requires one (an SSO token refresh).
 */
export async function verifyAwsCredentialChain(
  profile: string | undefined
): Promise<{ readonly ok: true } | ({ readonly ok: false } & AwsChainFailure)> {
  try {
    await fromNodeProviderChain(profile ? { profile } : {})();
    return { ok: true };
  } catch (error) {
    return { ...classifyAwsChainFailure(error, profile), ok: false };
  }
}

/**
 * Build a per-request AWS credential resolver for the given profile
 * (`undefined` = the chain's default profile resolution, which still honors
 * `AWS_PROFILE`).
 *
 * The chain object is constructed eagerly — that does no IO — while
 * resolution stays lazy inside the returned closure, so each request pays a
 * fresh resolution and picks up an `aws sso login` performed mid-session
 * without an app restart.
 *
 * The declared return type is the load-bearing fidelity check for
 * `aws-credential-identity.ts`: the SDK's own provider type must remain
 * assignable to our import-free declaration, or this line fails to compile.
 */
export function createAwsCredentialChain(
  profile: string | undefined
): AwsCredentialIdentityProvider {
  const chain = fromNodeProviderChain(profile ? { profile } : {});
  return async () => {
    try {
      return await chain();
    } catch (error) {
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        cause: error,
        context: { authKind: 'aws', awsAuthMode: 'profile_chain' },
        detail: describeAwsChainFailure(error, profile),
      });
    }
  };
}
