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
 * Anything that is NOT a recognized chain failure keeps its own `unknown`
 * kind rather than being folded into one of the two known causes (NO SILENT
 * FALLBACKS): a DNS failure during an SSO refresh must not read as "run aws
 * sso login". Its user-visible text is mapped to a BOUNDED set of shapes and
 * never interpolates the raw SDK message (PR #2525 review, finding 7) — that
 * message is upstream-controlled and can carry paths, ARNs, account ids, or
 * proxy URLs. The raw text rides the typed error's `cause` for main-side logs.
 */
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
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

  // Unrecognized. The raw SDK text is NOT interpolated (PR #2525 review,
  // finding 7): it is upstream-controlled and can carry file paths, ARNs,
  // account ids, assumed-role names, or proxy URLs from the user's AWS
  // environment, and this string reaches the renderer and the settings row.
  // Known-but-benign shapes get a specific line; anything else gets a generic
  // one, with the raw text left for the main-side log.
  return { detail: describeUnknownChainFailure(message, profileName), kind: 'unknown' };
}

/**
 * Bounded map from recognized failure SHAPES to fixed strings. Matching is on
 * the message; the message itself is never echoed.
 */
const UNKNOWN_CHAIN_FAILURE_SHAPES: readonly { readonly detail: string; readonly match: RegExp }[] =
  [
    {
      detail: 'the AWS credential chain could not reach the network',
      match: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket hang up|network/i,
    },
    { detail: 'the AWS credential chain timed out', match: /ETIMEDOUT|timed? ?out|abort/i },
    {
      detail: 'AWS rejected the credentials or role assumption',
      match: /AccessDenied|UnrecognizedClient|InvalidClientTokenId|not authorized|AssumeRole/i,
    },
    {
      detail: 'the AWS profile or config file could not be read',
      match: /ENOENT|EACCES|could not be parsed|malformed|profile/i,
    },
  ];

function describeUnknownChainFailure(message: string, profileName: string): string {
  const shape = UNKNOWN_CHAIN_FAILURE_SHAPES.find((entry) => entry.match.test(message));
  const cause = shape ? shape.detail : 'the AWS credential chain failed; see the desktop logs';
  return `AWS credential resolution failed for profile "${profileName}" — ${cause}.`;
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
  profile: string | undefined,
  options: { readonly timeoutMs?: number } = {}
): Promise<{ readonly ok: true } | ({ readonly ok: false } & AwsChainFailure)> {
  try {
    // BOUNDED (PR #2525 review, finding 3). Chain resolution is NOT
    // inherently bounded: `credential_process` can spawn a hanging child, an
    // SSO refresh can stall on a black-holed proxy, and IMDS can sit at its
    // own long connect timeout. Without this the probe's single-flight entry
    // would never settle and every later click would await the same dead
    // promise — the settings row would spin forever.
    //
    // The resolved identity is deliberately DISCARDED: this is a yes/no
    // probe, and key material must not travel back toward the renderer.
    await withChainTimeout(fromNodeProviderChain(profile ? { profile } : {})(), options.timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ...classifyAwsChainFailure(error, profile), ok: false };
  }
}

/** Marker for a chain resolution that blew its deadline. */
class AwsChainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`AWS credential chain timed out after ${timeoutMs}ms`);
    this.name = 'AwsChainTimeoutError';
  }
}

function withChainTimeout<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return work;
  }
  // `AbortSignal.timeout` gives a self-clearing timer that cannot keep the
  // process alive; the chain SDK does not accept a signal, so the race is
  // what actually bounds us.
  const signal = AbortSignal.timeout(timeoutMs);
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new AwsChainTimeoutError(timeoutMs)), {
        once: true,
      });
    }),
  ]);
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
      throw toTypedChainError(error, profile);
    }
  };
}

function toTypedChainError(error: unknown, profile: string | undefined): Error {
  return createMastraAgentError('mastra_agent_runtime_init_failed', {
    cause: error,
    context: { authKind: 'aws', awsAuthMode: 'profile_chain' },
    detail: describeAwsChainFailure(error, profile),
  });
}

/**
 * Resolve the chain NOW and return a provider that REPLAYS the result.
 *
 * PR #2525 review, finding 2 — this exists because of an upstream behavior,
 * not for style. `@ai-sdk/amazon-bedrock` wraps its `credentialProvider()`
 * call in try/catch and re-throws a PLAIN `Error`:
 *
 *   catch (error) { throw new Error(`AWS credential provider failed: ${…}`) }
 *
 * The message survives, so a lazily-throwing provider LOOKS fine — but the
 * class, the `mastra_agent_runtime_init_failed` code, and the `awsAuthMode`
 * context are destroyed, and the typed run-error envelope never sees them.
 * Resolving here, BEFORE the provider reaches `createAmazonBedrock`, means
 * our typed error is thrown outside that catch and arrives intact.
 *
 * Per-request freshness is unaffected: callers build the auth input per
 * request, so the chain is still consulted once per turn and an `aws sso
 * login` performed mid-session is picked up on the next message. What is
 * given up is re-resolution *between signatures within one request*, which
 * the SigV4 signer never needed.
 *
 * `resolve` is injectable purely so tests can drive both outcomes without a
 * real `~/.aws`; production passes nothing.
 */
export async function resolveAwsCredentialChain(
  profile: string | undefined,
  resolve: AwsCredentialIdentityProvider = createRawChain(profile)
): Promise<AwsCredentialIdentityProvider> {
  let identity: Awaited<ReturnType<AwsCredentialIdentityProvider>>;
  try {
    identity = await resolve();
  } catch (error) {
    throw toTypedChainError(error, profile);
  }
  return () => Promise.resolve(identity);
}

/** The untranslated chain — only `resolveAwsCredentialChain` consumes it. */
function createRawChain(profile: string | undefined): AwsCredentialIdentityProvider {
  const chain = fromNodeProviderChain(profile ? { profile } : {});
  return () => chain();
}
