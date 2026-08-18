/**
 * Provider-agnostic OAuth engine contract (BST-1355).
 *
 * The desktop main process owns every OAuth flow (PKCE + loopback, RFC 8628
 * device grant, refresh). The renderer NEVER sees token material: the only
 * renderer-visible surface is {@link ProviderAuthStatus} through the
 * `window.providerAuth` bridge ({@link ProviderAuthBridge}), and every status
 * variant is token-free by construction (legal gate BST-1351, constraint 3).
 *
 * Descriptors ({@link OAuthProviderDescriptor}) describe a provider's OAuth
 * endpoints and shapes. THIS ticket ships the engine only — no active
 * descriptors. BST-1356 registers the first real descriptor (OpenAI Codex).
 */

/** Closed union of renderer-visible failure codes. Never carries server text
 * or token material — message detail stays in main-process logs. */
export type ProviderAuthErrorCode =
  | 'browser_open_failed'
  | 'callback_timeout'
  | 'credential_persist_failed'
  | 'credential_unreadable'
  | 'device_flow_denied'
  | 'device_flow_expired'
  | 'device_flow_failed'
  | 'device_flow_unsupported'
  | 'flow_already_active'
  | 'flow_failed'
  | 'port_in_use'
  | 'refresh_token_missing'
  | 'token_exchange_failed'
  | 'unknown_provider';

/**
 * Renderer-visible provider-auth state. This is the ONLY payload that crosses
 * IPC for provider auth. It must never grow a field that carries token
 * material; the no-token-over-IPC test in
 * `apps/desktop/src/__tests__/provider-auth-ipc.test.ts` pins this.
 */
export type ProviderAuthStatus =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'awaiting_browser' }
  | { state: 'awaiting_device_code'; userCode: string; verificationUri: string }
  | { state: 'connected'; accountId?: string }
  | { state: 'error'; code: ProviderAuthErrorCode }
  | { state: 'reconnect_required' };

export type ProviderAuthState = ProviderAuthStatus['state'];

/** Which interactive flow `start` runs. Descriptors without `deviceFlow`
 * reject `'device'` with `device_flow_unsupported` (no silent fallback). */
export type ProviderAuthStartMethod = 'device' | 'loopback';

/**
 * A successful token grant as the engine consumes it (main process only —
 * this type never crosses IPC). `raw` preserves the full token-endpoint
 * response body so {@link OAuthProviderDescriptor.extractAccountId} can read
 * provider-specific claims (e.g. Codex id_token account id).
 */
export interface OAuthTokenGrant {
  readonly accessToken: string;
  /** Access-token lifetime. Absent when the provider omits `expires_in`. */
  readonly expiresInSeconds?: number;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly refreshToken: string;
}

/** Parsed device-authorization start result, normalized to milliseconds. */
export interface DeviceFlowStart {
  /** Opaque poll handle (RFC 8628 `device_code`, Codex `device_auth_id`). */
  readonly deviceCode: string;
  readonly expiresInMs: number;
  /** Adapter-private carry for non-standard flows (never crosses IPC). */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly intervalMs: number;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
}

/**
 * Adapter classification of one poll response. `authorization_code` supports
 * flows whose poll success yields a code (+ server-supplied PKCE verifier)
 * that still needs a standard token exchange — e.g. OpenAI Codex's
 * non-standard device flow. The engine performs that exchange itself.
 */
export type DeviceFlowPollOutcome =
  | { kind: 'tokens'; tokens: OAuthTokenGrant }
  | { kind: 'authorization_code'; code: string; codeVerifier: string; redirectUri: string }
  | { kind: 'pending' }
  | { kind: 'slow_down'; intervalMs?: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failure'; message: string };

/** One HTTP request the engine performs on the adapter's behalf. */
export interface DeviceFlowHttpRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

/** Raw HTTP response handed to the adapter. `body` is the JSON-parsed
 * response body, or `undefined` when the body is not valid JSON (adapters
 * that classify purely on status — e.g. Codex 403/404 = pending — ignore
 * it). */
export interface DeviceFlowHttpResponse {
  readonly body: unknown;
  readonly status: number;
}

/**
 * Descriptor-supplied response-shape adapter for device flows. The engine
 * owns the polling loop (interval, slow_down backoff, deadline, cancellation)
 * and the follow-up token exchange; the adapter owns request/response shape
 * only — so a non-standard flow (Codex) is expressible with zero engine
 * changes.
 */
export interface DeviceFlowResponseAdapter {
  readonly buildPollRequest: (
    descriptor: OAuthProviderDescriptor,
    start: DeviceFlowStart
  ) => DeviceFlowHttpRequest;
  readonly buildStartRequest: (descriptor: OAuthProviderDescriptor) => DeviceFlowHttpRequest;
  readonly classifyPollResponse: (response: DeviceFlowHttpResponse) => DeviceFlowPollOutcome;
  /** Throws on an unusable start response (surfaced as `device_flow_failed`). */
  readonly parseStartResponse: (response: DeviceFlowHttpResponse) => DeviceFlowStart;
}

export interface OAuthDeviceFlowDescriptor {
  readonly pollUrl: string;
  /** Response-shape adapter; omitted = RFC 8628 shapes. */
  readonly responseAdapter?: DeviceFlowResponseAdapter;
  readonly startUrl: string;
  /** Shown to the user alongside the user code. */
  readonly verificationUri: string;
}

/**
 * Everything the engine needs to run OAuth for one provider. Real
 * registrations pin `redirectPort` because loopback OAuth client
 * registrations pin the exact redirect URI — the engine NEVER falls back to a
 * random port. (Test fixtures may use port 0 and inject the bound port; the
 * fixed-port rule is a property of real descriptors.)
 */
export interface OAuthProviderDescriptor {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly deviceFlow?: OAuthDeviceFlowDescriptor;
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
  /** Derive a display/account identifier from the token grant (runs in main;
   * result is the only grant-derived value that ever crosses IPC). */
  readonly extractAccountId?: (grant: OAuthTokenGrant) => string | undefined;
  readonly providerId: string;
  readonly redirectPath: string;
  readonly redirectPort: number;
  readonly scopes: readonly string[];
  readonly tokenUrl: string;
}

/**
 * Structural typing for the desktop `window.providerAuth` bridge. Mirrors the
 * SecretsBridge pattern (./secrets-bridge.ts): the desktop preload implements
 * it, and the preload-runtime contract test pins the exposed key set to
 * {@link PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS}. Every method resolves to a
 * token-free {@link ProviderAuthStatus}; failures are serialized as
 * `{ state: 'error', code }` data, never thrown across invoke.
 */
export interface ProviderAuthBridge {
  cancel: (provider: string) => Promise<ProviderAuthStatus>;
  disconnect: (provider: string) => Promise<ProviderAuthStatus>;
  start: (provider: string, method?: ProviderAuthStartMethod) => Promise<ProviderAuthStatus>;
  status: (provider: string) => Promise<ProviderAuthStatus>;
}

// Compile-time exact-set proof (same pattern as SecretsBridge): missing or
// excess keys fail the build, so the pin can never drift from the interface.
const PROVIDER_AUTH_BRIDGE_REQUIRED_METHOD_SET = {
  cancel: true,
  disconnect: true,
  start: true,
  status: true,
} as const satisfies Record<keyof ProviderAuthBridge, true>;

/** Every method the preload's `window.providerAuth` surface must expose. */
export const PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS = Object.keys(
  PROVIDER_AUTH_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof ProviderAuthBridge)[];
