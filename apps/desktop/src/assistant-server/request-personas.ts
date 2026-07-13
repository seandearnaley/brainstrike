/**
 * Per-request persona resolution (desktop assistant server).
 *
 * Merges the built-in personas with the user-defined personas scanned from
 * disk, applies the renderer's availability preferences (a presence-means-on
 * wire field, mirrors `permissionPolicyRequest`), and resolves API keys for
 * cross-provider model pins via the server's secrets bridge.
 *
 * Trust boundaries:
 * - The request field is renderer PREFERENCE data (which personas to enable) —
 *   malformed shapes degrade to defaults with a warn. It can only ever REDUCE
 *   the persona set, never inject personas or keys.
 * - `personaProviderApiKeys` is server-resolved here and set on the runtime;
 *   a client-supplied value is stripped by the caller (same posture as
 *   `permissionPolicy`).
 * - A user-persona disk-scan failure degrades to built-ins with a warn — a
 *   broken `.brainstrike/agents` dir must not take down chat.
 */

import { PERSONA_PIN_KEYLESS_PROVIDERS } from '@brainstrike/agent';
import {
  type AssistantPersonaDefinition,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
import type { ScopedLogger } from '@brainstrike/utils';
import type { UserPersonaScanResult } from './user-personas-loader';

/**
 * The renderer's persona availability preference, carried on the request data
 * (see `subagentPersonasRequest` in the wire types). Absent field = defaults
 * (delegation on, nothing disabled).
 */
export interface SubagentPersonasRequest {
  readonly delegationEnabled?: boolean;
  readonly disabledPersonaIds?: readonly string[];
}

export interface ResolveRequestPersonasParams {
  readonly logger: ScopedLogger;
  /** The parent run's provider (its key is reused for same-provider pins). */
  readonly parentProvider: string;
  readonly request: SubagentPersonasRequest | undefined;
  /** Secrets-bridge key lookup for cross-provider pins. */
  readonly resolveApiKey: (provider: string) => Promise<string | undefined>;
  /** Injected scan (production: user-personas-loader over the real fs). */
  readonly scanUserPersonas: () => UserPersonaScanResult;
}

export interface ResolvedRequestPersonas {
  /** Server-resolved keys for cross-provider pins; absent when none resolved. */
  readonly personaProviderApiKeys?: Readonly<Record<string, string>>;
  readonly personas: readonly AssistantPersonaDefinition[];
}

function sanitizeDisabledIds(
  request: SubagentPersonasRequest | undefined,
  logger: ScopedLogger
): ReadonlySet<string> {
  const raw = request?.disabledPersonaIds;
  if (raw === undefined) {
    return new Set();
  }
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    logger.warn('Malformed disabledPersonaIds on the persona request; ignoring the field', {
      received: typeof raw,
    });
    return new Set();
  }
  return new Set(raw);
}

/**
 * Resolve the personas (and pinned-provider keys) for one request. Never
 * throws: every failure mode degrades toward "fewer personas" with a warn.
 */
export async function resolveRequestPersonas(
  params: ResolveRequestPersonasParams
): Promise<ResolvedRequestPersonas> {
  if (params.request?.delegationEnabled === false) {
    return { personas: [] };
  }

  let userPersonas: readonly AssistantPersonaDefinition[] = [];
  try {
    userPersonas = params.scanUserPersonas().personas;
  } catch (error) {
    params.logger.warn('User persona scan failed; continuing with built-in personas only', {
      error,
    });
  }

  const disabled = sanitizeDisabledIds(params.request, params.logger);
  const personas = [...BUILT_IN_PERSONAS, ...userPersonas].filter(
    (persona) => !disabled.has(persona.id)
  );

  // Resolve keys for every DISTINCT cross-provider pin that needs one. Missing
  // keys are not an error here: the agent factory owns the skip-with-warn
  // decision (single point of truth), this just supplies what it can.
  const pinnedProviders = new Set<string>();
  for (const persona of personas) {
    const pin = persona.model;
    if (
      pin &&
      pin.provider !== params.parentProvider &&
      !PERSONA_PIN_KEYLESS_PROVIDERS.has(pin.provider)
    ) {
      pinnedProviders.add(pin.provider);
    }
  }
  const keyEntries: [string, string][] = [];
  for (const provider of pinnedProviders) {
    try {
      const key = await params.resolveApiKey(provider);
      if (key) {
        keyEntries.push([provider, key]);
      }
    } catch (error) {
      params.logger.warn('Failed to resolve API key for pinned persona provider', {
        error,
        provider,
      });
    }
  }

  return {
    personas,
    ...(keyEntries.length > 0 ? { personaProviderApiKeys: Object.fromEntries(keyEntries) } : {}),
  };
}
