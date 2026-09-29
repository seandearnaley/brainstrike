import type { StreamChunk } from '@brainstrike/agent/hosted-web';
import {
  AssistantFilterPayloadError,
  prepareAssistantPostRequest,
} from '@brainstrike/assistant-service/request';
import type { AssistantRejectionPayload } from '@brainstrike/assistant-wire';
import {
  resolveAssistantProviderConfig,
  resolveAssistantProviderConfigs,
} from './assistant-config.js';
import {
  describeWebAssistantInputError,
  WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE,
} from './web-assistant-request.js';
import {
  filterWebAssistantPayload,
  InvalidWebAssistantRuntimeDataError,
} from './web-assistant-runtime.js';
import { buildWebAssistantStreamFromPrepared } from './web-assistant-stream.js';

// Match the native ESM logging export used by the hosted API.
type ScopedLogger = import('@brainstrike/logging', { with: {
  'resolution-mode': 'import',
}}).ScopedLogger;

export interface WebAssistantPostRejection {
  readonly kind: 'rejection';
  readonly payload: AssistantRejectionPayload;
  readonly status: number;
}

export type WebAssistantPostOutcome =
  | WebAssistantPostRejection
  | { readonly kind: 'stream'; readonly stream: AsyncIterable<StreamChunk> };

/**
 * The ONE Hosted Web assistant POST decision path (BST-973-2, Sean's ruling:
 * "if the web stuff can converge, it should"). Both web transports — the
 * deployed Vercel function (`app/api/assistant/route.ts`) and the Vite
 * dev/preview middleware (`assistant-stream-helpers.ts`) — consume this, so
 * dev and prod cannot drift apart on wire semantics.
 *
 * Flow, with what stays web-specific named:
 *   1. no keys configured at all -> 503 assistant_disabled — server state,
 *      ahead of request semantics;
 *   2. the SHARED prepareAssistantPostRequest with the env-key reader AND
 *      web's allow-list filter as its `filterPayload` hook (BST-1030 — the
 *      filter runs INSIDE preparation, post-parse/pre-validation, not as a
 *      separate step): unsupported data fields still 400
 *      invalid_runtime_data, non-hosted or unconfigured providers are
 *      rejected by the hook because the shared preparation waves keyless
 *      local-server providers through, absent provider is 400
 *      missing_provider (the old web-only default-provider fallback is
 *      gone), and rejection shapes and ordering match desktop;
 *   3. tool approval/resume -> 409 — ARCHITECTURAL (no durable workflow
 *      storage on stateless hosting), checked after preparation like desktop
 *      checks them;
 *   4. the stateless stream (no sessions, no persistence — the run-turn half
 *      stays desktop-only until durable storage exists).
 *
 * Transport-owned and NOT here: the bounded body read (413) and the
 * `last-event-id` -> 409 replay rejection, both of which touch the raw
 * request object each transport holds.
 */
export async function runWebAssistantPost(params: {
  readonly bodyText: string;
  /** Injected so each transport keeps its scope-cached logger identity. */
  readonly logger: ScopedLogger;
  readonly signal?: AbortSignal;
}): Promise<WebAssistantPostOutcome> {
  const configuredProviders = resolveAssistantProviderConfigs(resolveAssistantProviderConfig);
  if (configuredProviders.length === 0) {
    return {
      kind: 'rejection',
      payload: { error: 'assistant_disabled', reason: 'missing_api_key' },
      status: 503,
    };
  }

  const hostedProviders = configuredProviders.map((config) => config.provider);
  let prepared: Awaited<ReturnType<typeof prepareAssistantPostRequest>>;
  try {
    prepared = await prepareAssistantPostRequest({
      // The allow-list runs INSIDE preparation via the hook (BST-1030): one
      // parse total instead of web's previous parse -> stringify -> re-parse.
      filterPayload: (payload) => filterWebAssistantPayload(payload, hostedProviders),
      logger: params.logger,
      readBody: async () => params.bodyText,
      // BST-1352: Hosted Web adapts via `api_key` credentials ONLY — server
      // env keys are the sole web credential source (no typed-credential
      // resolution, no secret store on web).
      resolveProviderCredential: async (provider) => {
        const apiKey = configuredProviders.find((config) => config.provider === provider)?.apiKey;
        return apiKey === undefined ? undefined : { key: apiKey, source: 'env', type: 'api_key' };
      },
    });
  } catch (error) {
    // Preparation tags EVERY hook throw as AssistantFilterPayloadError and
    // rethrows it unmapped; this transport unwraps the cause and owns its
    // wire shape (allow-list / provider-membership rejections).
    const hookCause = error instanceof AssistantFilterPayloadError ? error.cause : error;
    const rejection = describeWebAssistantRejection(hookCause);
    if (!rejection) {
      throw hookCause instanceof Error ? hookCause : error;
    }
    return rejection;
  }
  if (!prepared.ok) {
    // Destructuring drops closeConnection EXPLICITLY: the 413 path is
    // unreachable here (each transport bounds the body before this runs), and
    // stateless/managed hosts have no connection to instruct.
    return {
      kind: 'rejection',
      payload: prepared.rejection.payload,
      status: prepared.rejection.status,
    };
  }

  if (prepared.request.toolApprovalAction) {
    return {
      kind: 'rejection',
      payload: {
        error: 'tool_approval_unavailable',
        message: 'Hosted Web tool approval requires durable workflow storage.',
      },
      status: 409,
    };
  }
  if (prepared.request.toolResumeAction) {
    return {
      kind: 'rejection',
      payload: {
        error: 'tool_resume_unavailable',
        message: 'Hosted Web tool resume requires durable workflow storage.',
      },
      status: 409,
    };
  }

  try {
    const stream = await buildWebAssistantStreamFromPrepared({
      agentMessages: prepared.request.messages,
      credential: prepared.request.credential,
      runtimeData: prepared.request.runtimeData,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return { kind: 'stream', stream };
  } catch (error) {
    const rejection = describeWebAssistantRejection(error);
    if (rejection) {
      return rejection;
    }
    params.logger.error('Failed to initialize assistant stream', { error });
    return {
      kind: 'rejection',
      payload: WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.payload,
      status: WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.status,
    };
  }
}

function describeWebAssistantRejection(error: unknown): WebAssistantPostRejection | undefined {
  const inputError = describeWebAssistantInputError(error);
  if (inputError) {
    return { kind: 'rejection', payload: inputError.payload, status: inputError.status };
  }
  if (error instanceof InvalidWebAssistantRuntimeDataError) {
    return {
      kind: 'rejection',
      payload: { error: 'invalid_runtime_data', message: error.message },
      status: 400,
    };
  }
  return;
}
