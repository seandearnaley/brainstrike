import os from 'node:os';
import type {
  DeviceFlowHttpResponse,
  DeviceFlowPollOutcome,
  DeviceFlowResponseAdapter,
  DeviceFlowStart,
  OAuthProviderDescriptor,
  OAuthTokenGrant,
} from '@brainstrike/assistant-contract';
import { DEVICE_FLOW_MIN_INTERVAL_MS, positiveSecondsToMs } from '../device-flow.js';

/**
 * OpenAI Codex (ChatGPT subscription) OAuth descriptor — BST-1356.
 *
 * Governed by `docs/OAUTH_LEGAL_REVIEW_GATE.md` (APPROVED WITH CONSTRAINTS,
 * 2026-08-18). Constraints this module carries directly:
 *
 * - **5 (identify honestly):** `originator: brainstrike` — never another
 *   tool's originator string. The client id below is OpenAI's public Codex CLI
 *   registration, used per the ecosystem precedent recorded in the gate doc
 *   (Zed ships it in collaboration with OpenAI; opencode ships it natively).
 * - **8 (re-verify at implementation time):** every constant here was
 *   re-verified on 2026-08-18 against opencode `dev` HEAD `0033bb3559`
 *   (`packages/opencode/src/plugin/openai/codex.ts`). NOTE: the repository was
 *   renamed `sst/opencode` -> `anomalyco/opencode` and its default branch is
 *   `dev`. Two changes have landed since the v1.18.2 baseline: the `gpt-5.6`
 *   context-limit override was collapsed into gpt-5.5's (moot here — gpt-5.6
 *   is not in our allowed set), and the data-residency header below was added
 *   (#42432), which we mirror.
 *
 * The engine (BST-1355) owns PKCE, the loopback server, the poll loop, the
 * token exchange and refresh; this module supplies ONLY the Codex-specific
 * endpoints, wire shapes and claim reads.
 */

export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';

/** OpenAI's public Codex CLI client registration (gate doc, Residual risks). */
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const CODEX_ISSUER = 'https://auth.openai.com';

export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;

/** Loopback redirect is pinned by the client registration — never random. */
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_PATH = '/auth/callback';

/**
 * Codex's device authorization is NOT RFC 8628: the endpoints live under
 * `/api/accounts/deviceauth`, the bodies are JSON, 403/404 mean "keep
 * polling", and a successful poll returns an authorization code plus a
 * SERVER-supplied PKCE verifier that still needs a standard token exchange.
 */
export const CODEX_DEVICE_START_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_POLL_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
/** Where the user types the code. */
export const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_ISSUER}/codex/device`;
/** Redirect URI the device-flow token exchange must present. */
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;

/** The Codex backend the runtime rewrites chat/responses traffic onto. */
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * The device usercode response carries no `expires_in`. opencode polls
 * unboundedly; we bound the flow so a forgotten sign-in cannot poll forever.
 * 15 minutes is generous for a cross-device code entry.
 */
export const CODEX_DEVICE_EXPIRES_MS = 15 * 60 * 1000;

const JSON_HEADERS = {
  // biome-ignore lint/style/useNamingConvention: standard HTTP header name.
  Accept: 'application/json',
  'Content-Type': 'application/json',
} as const;

/** Honest client identification (gate constraint 5). */
export function buildCodexUserAgent(appVersion: string): string {
  return `brainstrike/${appVersion} (${os.platform()} ${os.release()}; ${os.arch()})`;
}

export interface CodexTokenClaims {
  // biome-ignore-start lint/style/useNamingConvention: OpenAI JWT claim names.
  readonly chatgpt_account_id?: string;
  readonly chatgpt_compute_residency?: string;
  readonly email?: string;
  readonly 'https://api.openai.com/auth'?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_compute_residency?: string;
  };
  // biome-ignore-end lint/style/useNamingConvention: OpenAI JWT claim names.
  readonly organizations?: readonly { readonly id?: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a JWT payload. Returns undefined for anything unparseable — the
 * caller treats a missing claim as "no account id", never as an error. */
export function parseJwtClaims(token: string): CodexTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return;
  }
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) {
    return;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(decoded) ? (decoded as CodexTokenClaims) : undefined;
  } catch {
    return;
  }
}

/** Claim precedence per opencode: top-level, then the namespaced auth claim,
 * then the first organization. */
export function extractAccountIdFromClaims(claims: CodexTokenClaims): string | undefined {
  const namespaced = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  const organizationId = claims.organizations?.[0]?.id;
  return claims.chatgpt_account_id ?? namespaced ?? organizationId;
}

/** id_token first, then the access token (opencode order). */
export function extractCodexAccountId(grant: OAuthTokenGrant): string | undefined {
  const idToken = grant.raw['id_token'];
  if (typeof idToken === 'string') {
    const claims = parseJwtClaims(idToken);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId !== undefined) {
      return accountId;
    }
  }
  const claims = parseJwtClaims(grant.accessToken);
  return claims ? extractAccountIdFromClaims(claims) : undefined;
}

/**
 * Data-residency constraint for the request-routing header (opencode
 * `extractResidency`, added upstream 2026-08-17 in #42432). Read from the
 * ACCESS token, and — unlike the account id — the NAMESPACED claim wins over
 * the top-level one. That asymmetry is deliberate upstream; it is reproduced
 * here rather than "corrected".
 */
export function extractCodexResidency(accessToken: string): string | undefined {
  const claims = parseJwtClaims(accessToken);
  if (!claims) {
    return;
  }
  const residency =
    claims['https://api.openai.com/auth']?.chatgpt_compute_residency ??
    claims.chatgpt_compute_residency;
  if (residency === undefined || residency.length === 0 || residency === 'no_constraint') {
    return;
  }
  return residency;
}

function readString(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) {
    return;
  }
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Codex-shaped device-flow adapter. Shapes only — the engine owns the loop. */
export function createCodexDeviceFlowAdapter(userAgent: string): DeviceFlowResponseAdapter {
  const headers = { ...JSON_HEADERS, 'User-Agent': userAgent } as const;
  return {
    buildPollRequest: (descriptor, start: DeviceFlowStart) => ({
      // biome-ignore-start lint/style/useNamingConvention: Codex wire fields.
      body: JSON.stringify({ device_auth_id: start.deviceCode, user_code: start.userCode }),
      // biome-ignore-end lint/style/useNamingConvention: Codex wire fields.
      headers,
      url: descriptor.deviceFlow?.pollUrl ?? CODEX_DEVICE_POLL_URL,
    }),
    buildStartRequest: (descriptor) => ({
      // biome-ignore-start lint/style/useNamingConvention: Codex wire fields.
      body: JSON.stringify({ client_id: descriptor.clientId }),
      // biome-ignore-end lint/style/useNamingConvention: Codex wire fields.
      headers,
      url: descriptor.deviceFlow?.startUrl ?? CODEX_DEVICE_START_URL,
    }),
    classifyPollResponse: (response: DeviceFlowHttpResponse): DeviceFlowPollOutcome => {
      // Codex signals "not authorized yet" with 403/404 and no error body, so
      // pending is classified on STATUS alone.
      if (response.status === 403 || response.status === 404) {
        return { kind: 'pending' };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          kind: 'failure',
          message: `Codex device authorization poll failed with status ${response.status}.`,
        };
      }
      const code = readString(response.body, 'authorization_code');
      const codeVerifier = readString(response.body, 'code_verifier');
      if (code === undefined || codeVerifier === undefined) {
        return {
          kind: 'failure',
          message:
            'Codex device authorization succeeded but returned no authorization_code/code_verifier pair.',
        };
      }
      return {
        code,
        codeVerifier,
        kind: 'authorization_code',
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
      };
    },
    parseStartResponse: (response: DeviceFlowHttpResponse): DeviceFlowStart => {
      const deviceAuthId = readString(response.body, 'device_auth_id');
      const userCode = readString(response.body, 'user_code');
      if (
        response.status < 200 ||
        response.status >= 300 ||
        deviceAuthId === undefined ||
        userCode === undefined
      ) {
        throw new Error(
          `Codex device authorization start response is unusable (status ${response.status}).`
        );
      }
      const rawInterval = isRecord(response.body) ? response.body['interval'] : undefined;
      return {
        deviceCode: deviceAuthId,
        expiresInMs: CODEX_DEVICE_EXPIRES_MS,
        // Codex returns `interval` as a STRING of seconds.
        intervalMs: Math.max(
          positiveSecondsToMs(rawInterval, DEVICE_FLOW_MIN_INTERVAL_MS),
          DEVICE_FLOW_MIN_INTERVAL_MS
        ),
        userCode,
        verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      };
    },
  };
}

export interface OpenAiCodexDescriptorOptions {
  /** A launch's loopback stand-in issuer (isolated E2E only); the shipped issuer otherwise. */
  readonly issuer?: string;
  /** Honest UA; built by {@link buildCodexUserAgent} from `app.getVersion()`. */
  readonly userAgent: string;
}

export function createOpenAiCodexDescriptor(
  options: OpenAiCodexDescriptorOptions
): OAuthProviderDescriptor {
  const issuer = options.issuer ?? CODEX_ISSUER;
  return {
    authorizeUrl: `${issuer}/oauth/authorize`,
    clientId: OPENAI_CODEX_CLIENT_ID,
    deviceFlow: {
      pollUrl: `${issuer}/api/accounts/deviceauth/token`,
      responseAdapter: createCodexDeviceFlowAdapter(options.userAgent),
      startUrl: `${issuer}/api/accounts/deviceauth/usercode`,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
    },
    extraAuthorizeParams: {
      // biome-ignore-start lint/style/useNamingConvention: OpenAI wire params.
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
      // biome-ignore-end lint/style/useNamingConvention: OpenAI wire params.
      // Gate constraint 5: identify as ourselves, never as another tool.
      originator: 'brainstrike',
    },
    extractAccountId: extractCodexAccountId,
    providerId: OPENAI_CODEX_PROVIDER_ID,
    redirectPath: CODEX_REDIRECT_PATH,
    redirectPort: CODEX_REDIRECT_PORT,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenUrl: `${issuer}/oauth/token`,
  };
}
