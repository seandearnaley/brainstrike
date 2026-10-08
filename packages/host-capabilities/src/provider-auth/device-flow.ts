import type {
  DeviceFlowHttpRequest,
  DeviceFlowHttpResponse,
  DeviceFlowPollOutcome,
  DeviceFlowResponseAdapter,
  DeviceFlowStart,
  OAuthProviderDescriptor,
  OAuthTokenGrant,
} from '@brainstrike/assistant-contract';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Clock, Effect } from 'effect';
import { ProviderAuthFlowCancelledError, ProviderAuthFlowError } from './errors.js';
import { guardedFetchText } from './fetch-guards.js';

/**
 * Generic device-authorization poller (BST-1355). The engine owns the loop
 * mechanics — interval + safety margin, RFC 8628 §3.5 slow_down backoff, the
 * hard deadline, cancellation — while the descriptor's
 * {@link DeviceFlowResponseAdapter} owns request/response SHAPE only. That
 * split is what lets a non-standard flow (opencode's Codex: JSON bodies,
 * 403/404 = keep polling, poll success yields an authorization code plus a
 * server-supplied code_verifier) plug in with zero engine changes.
 */

export const DEVICE_FLOW_DEFAULT_INTERVAL_MS = 5000;
export const DEVICE_FLOW_MIN_INTERVAL_MS = 1000;
export const DEVICE_FLOW_SLOW_DOWN_INCREMENT_MS = 5000;
export const DEVICE_FLOW_POLL_SAFETY_MARGIN_MS = 3000;
export const DEVICE_FLOW_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;

/**
 * Normalize a server-supplied seconds value to milliseconds, using the
 * default when the input is missing, non-positive, or not finite. Defends the
 * loop against `NaN`/`"NaN"`/`null`/negative values from a misbehaving
 * endpoint (a NaN interval would otherwise reach setTimeout as 0 and
 * busy-loop until the deadline).
 */
export function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

function parseTokenGrant(body: Record<string, unknown>): OAuthTokenGrant | undefined {
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return;
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // A grant without a refresh token cannot sustain a subscription session;
    // surfacing it as a failure is deliberate (NO SILENT FALLBACKS).
    return;
  }
  const expiresIn = Number(body['expires_in']);
  return {
    accessToken,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresInSeconds: expiresIn } : {}),
    raw: body,
    refreshToken,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FORM_HEADERS = {
  // biome-ignore lint/style/useNamingConvention: standard HTTP header name.
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
} as const;

/** RFC 8628-shaped adapter, used when a descriptor supplies no custom one. */
export const RFC8628_DEVICE_FLOW_ADAPTER: DeviceFlowResponseAdapter = {
  buildPollRequest: (descriptor, start) => {
    if (!descriptor.deviceFlow) {
      throw new ProviderAuthFlowError(
        'device_flow_unsupported',
        `Provider ${descriptor.providerId} has no device flow descriptor.`
      );
    }
    return {
      // biome-ignore-start lint/style/useNamingConvention: RFC 8628 wire fields.
      body: new URLSearchParams({
        client_id: descriptor.clientId,
        device_code: start.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      // biome-ignore-end lint/style/useNamingConvention: RFC 8628 wire fields.
      headers: FORM_HEADERS,
      url: descriptor.deviceFlow.pollUrl,
    };
  },
  buildStartRequest: (descriptor) => {
    if (!descriptor.deviceFlow) {
      throw new ProviderAuthFlowError(
        'device_flow_unsupported',
        `Provider ${descriptor.providerId} has no device flow descriptor.`
      );
    }
    return {
      // biome-ignore-start lint/style/useNamingConvention: RFC 8628 wire fields.
      body: new URLSearchParams({
        client_id: descriptor.clientId,
        scope: descriptor.scopes.join(' '),
      }).toString(),
      // biome-ignore-end lint/style/useNamingConvention: RFC 8628 wire fields.
      headers: FORM_HEADERS,
      url: descriptor.deviceFlow.startUrl,
    };
  },
  classifyPollResponse: (response) => {
    const body = isRecord(response.body) ? response.body : {};
    if (response.status >= 200 && response.status < 300) {
      const tokens = parseTokenGrant(body);
      if (!tokens) {
        return {
          kind: 'failure',
          message: 'Token response is missing access_token or refresh_token.',
        };
      }
      return { kind: 'tokens', tokens };
    }
    switch (body['error']) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'expired_token':
        return { kind: 'expired' };
      case 'access_denied':
      case 'authorization_denied':
        return { kind: 'denied' };
      default:
        return {
          kind: 'failure',
          message: `Device token poll failed with status ${response.status}.`,
        };
    }
  },
  parseStartResponse: (response) => {
    const body = isRecord(response.body) ? response.body : {};
    const deviceCode = body['device_code'];
    const userCode = body['user_code'];
    const verificationUri = body['verification_uri'];
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof deviceCode !== 'string' ||
      typeof userCode !== 'string' ||
      typeof verificationUri !== 'string'
    ) {
      throw new Error(
        `Device authorization start response is unusable (status ${response.status}).`
      );
    }
    const verificationUriComplete = body['verification_uri_complete'];
    return {
      deviceCode,
      expiresInMs: positiveSecondsToMs(body['expires_in'], DEVICE_FLOW_DEFAULT_EXPIRES_MS),
      intervalMs: Math.max(
        positiveSecondsToMs(body['interval'], DEVICE_FLOW_DEFAULT_INTERVAL_MS),
        DEVICE_FLOW_MIN_INTERVAL_MS
      ),
      userCode,
      verificationUri,
      ...(typeof verificationUriComplete === 'string' ? { verificationUriComplete } : {}),
    };
  },
};

export interface DeviceFlowDeps {
  /** Abort the poll loop (maps to `ProviderAuthFlowCancelledError`). */
  readonly cancelSignal?: AbortSignal;
  readonly fetchFn: typeof fetch;
  /** Per-request timeout; defaults to DEFAULT_FETCH_TIMEOUT_MS. */
  readonly fetchTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A terminal poll result the engine acts on: either a finished grant, or an
 * authorization code that still needs a standard token exchange. */
export type DeviceFlowTerminalOutcome = Extract<
  DeviceFlowPollOutcome,
  { kind: 'authorization_code' } | { kind: 'tokens' }
>;

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProviderAuthFlowCancelledError('Device flow cancelled.');
  }
}

function resolveAdapter(descriptor: OAuthProviderDescriptor): DeviceFlowResponseAdapter {
  if (!descriptor.deviceFlow) {
    throw new ProviderAuthFlowError(
      'device_flow_unsupported',
      `Provider ${descriptor.providerId} does not support the device flow.`
    );
  }
  return descriptor.deviceFlow.responseAdapter ?? RFC8628_DEVICE_FLOW_ADAPTER;
}

async function performRequest(
  deps: DeviceFlowDeps,
  providerId: string,
  request: DeviceFlowHttpRequest
): Promise<DeviceFlowHttpResponse> {
  const { response, text } = await guardedFetchText({
    ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
    fetchFn: deps.fetchFn,
    init: {
      body: request.body,
      headers: { ...request.headers },
      method: 'POST',
    },
    onTimeout: () =>
      new ProviderAuthFlowError(
        'device_flow_failed',
        `Device flow request for ${providerId} timed out.`
      ),
    ...(deps.fetchTimeoutMs === undefined ? {} : { timeoutMs: deps.fetchTimeoutMs }),
    url: request.url,
  });
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  return { body, status: response.status };
}

/** Kick off the device flow: one start request, parsed by the adapter. */
export async function startDeviceFlow(
  descriptor: OAuthProviderDescriptor,
  deps: DeviceFlowDeps
): Promise<DeviceFlowStart> {
  const adapter = resolveAdapter(descriptor);
  assertNotCancelled(deps.cancelSignal);
  const response = await performRequest(
    deps,
    descriptor.providerId,
    adapter.buildStartRequest(descriptor)
  );
  try {
    return adapter.parseStartResponse(response);
  } catch (error) {
    if (error instanceof ProviderAuthFlowError) {
      throw error;
    }
    throw new ProviderAuthFlowError(
      'device_flow_failed',
      `Device authorization start failed for ${descriptor.providerId}.`,
      error
    );
  }
}

/**
 * Poll until the flow terminates. Pending keeps the current interval;
 * slow_down raises it by the spec increment (or the adapter-supplied value)
 * and keeps polling; expired/denied/failure become typed errors; tokens or an
 * authorization code return to the caller. Every wait is
 * `interval + safety margin`, capped by the remaining deadline.
 */
export async function pollDeviceFlow(
  descriptor: OAuthProviderDescriptor,
  start: DeviceFlowStart,
  deps: DeviceFlowDeps
): Promise<DeviceFlowTerminalOutcome> {
  const adapter = resolveAdapter(descriptor);
  const readNow = deps.now ? Effect.sync(deps.now) : Clock.currentTimeMillis;
  const injectedSleep = deps.sleep;
  const wait = (ms: number) =>
    injectedSleep
      ? Effect.tryPromise({ catch: (error) => error, try: () => injectedSleep(ms) })
      : Effect.sleep(ms);
  const poll = Effect.gen(function* () {
    const deadline = (yield* readNow) + start.expiresInMs;
    let intervalMs = Math.max(start.intervalMs, DEVICE_FLOW_MIN_INTERVAL_MS);

    while ((yield* readNow) < deadline) {
      const response = yield* Effect.tryPromise({
        catch: (error: unknown): unknown => error,
        try: (signal) =>
          performRequest(
            { ...deps, cancelSignal: signal },
            descriptor.providerId,
            adapter.buildPollRequest(descriptor, start)
          ),
      });
      const outcome = adapter.classifyPollResponse(response);
      switch (outcome.kind) {
        case 'authorization_code':
        case 'tokens':
          return outcome;
        case 'pending':
          break;
        case 'slow_down':
          intervalMs =
            outcome.intervalMs !== undefined && Number.isFinite(outcome.intervalMs)
              ? Math.max(outcome.intervalMs, DEVICE_FLOW_MIN_INTERVAL_MS)
              : intervalMs + DEVICE_FLOW_SLOW_DOWN_INCREMENT_MS;
          break;
        case 'expired':
          return yield* Effect.fail(
            new ProviderAuthFlowError(
              'device_flow_expired',
              `Device code for ${descriptor.providerId} expired before authorization.`
            )
          );
        case 'denied':
          return yield* Effect.fail(
            new ProviderAuthFlowError(
              'device_flow_denied',
              `Device authorization for ${descriptor.providerId} was denied.`
            )
          );
        case 'failure':
          return yield* Effect.fail(
            new ProviderAuthFlowError(
              'device_flow_failed',
              `Device flow for ${descriptor.providerId} failed: ${outcome.message}`
            )
          );
        default: {
          const exhaustive: never = outcome;
          return yield* Effect.fail(
            new ProviderAuthFlowError(
              'device_flow_failed',
              `Unrecognized device flow outcome: ${JSON.stringify(exhaustive)}`
            )
          );
        }
      }
      const remaining = Math.max(0, deadline - (yield* readNow));
      yield* wait(Math.min(intervalMs + DEVICE_FLOW_POLL_SAFETY_MARGIN_MS, remaining));
    }
    return yield* Effect.fail(
      new ProviderAuthFlowError(
        'device_flow_expired',
        `Device authorization for ${descriptor.providerId} timed out.`
      )
    );
  });

  const cancellation = new AbortController();
  const onCancel = (): void => {
    cancellation.abort(new ProviderAuthFlowCancelledError('Device flow cancelled.'));
  };
  deps.cancelSignal?.addEventListener('abort', onCancel, { once: true });
  if (deps.cancelSignal?.aborted) {
    onCancel();
  }
  try {
    return await runAtPromiseBoundary(poll, { signal: cancellation.signal });
  } finally {
    deps.cancelSignal?.removeEventListener('abort', onCancel);
  }
}
