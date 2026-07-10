/**
 * Delegation safety rails (subagent personas, T3 / D7).
 *
 * A per-run {@link DelegationConfig} closure that Mastra invokes around every
 * subagent delegation. It enforces:
 * - **Unknown persona rejection** (no-silent-fallbacks): a delegation to a
 *   `primitiveId` we did not register must never proceed.
 * - **Concurrency + per-run caps**: at most {@link MAX_CONCURRENT_DELEGATIONS} in
 *   flight and {@link MAX_DELEGATIONS_PER_RUN} total.
 * - **maxSteps clamp**: a model-supplied `maxSteps` can never exceed the persona
 *   cap; `onDelegationStart` always returns `modifiedMaxSteps = min(cap, requested)`.
 *
 * `onDelegationComplete` decrements the in-flight counter and logs the outcome
 * (including the child's aggregate token usage — the parent meter does NOT
 * aggregate child tokens in v1, D-orchestrator ruling, so this log is the only
 * child-usage surface).
 */

import type { AssistantRunEventMetadata } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { ScopedLogger } from '@brainstrike/utils';
import type { DelegationConfig } from '@mastra/core/agent';

export const MAX_CONCURRENT_DELEGATIONS = 2;
export const MAX_DELEGATIONS_PER_RUN = 8;

export interface CreateDelegationConfigParams {
  readonly logger: ScopedLogger;
  /** Persona id → definition; the `primitiveId` Mastra passes is the persona id. */
  readonly personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
}

function clampMaxSteps(cap: number, requested: number | undefined): number {
  if (requested === undefined) {
    return cap;
  }
  return Math.min(cap, requested);
}

/**
 * Build a per-run delegation config. Call ONCE per run (the closure carries the
 * run's in-flight + total counters).
 */
export function createDelegationConfig(params: CreateDelegationConfigParams): DelegationConfig {
  // The closure is rebuilt per stream leg (initial / approval-resume / suspend-
  // resume), so `total` counts delegations WITHIN a leg, not across resumes — the
  // per-run cap is effectively a per-leg cap. Acceptable for v1: a leg is a single
  // model continuation, and cross-leg accumulation would need durable counters.
  let inFlight = 0;
  let total = 0;

  return {
    onDelegationComplete: (context) => {
      inFlight = Math.max(0, inFlight - 1);
      params.logger.info('Subagent delegation completed', {
        code: 'subagent_delegation_completed',
        durationMs: context.duration,
        personaId: context.primitiveId,
        success: context.success,
        usage: context.result.usage,
      });
    },
    onDelegationStart: (context) => {
      const persona = params.personasById.get(context.primitiveId);
      if (!persona) {
        params.logger.warn('Rejecting delegation to unknown persona', {
          code: 'subagent_delegation_unknown_persona',
          personaId: context.primitiveId,
        });
        return {
          proceed: false,
          rejectionReason: `Unknown subagent '${context.primitiveId}'.`,
        };
      }

      if (inFlight >= MAX_CONCURRENT_DELEGATIONS) {
        params.logger.warn('Rejecting delegation: concurrency cap reached', {
          code: 'subagent_delegation_concurrency_capped',
          inFlight,
          personaId: context.primitiveId,
        });
        return {
          proceed: false,
          rejectionReason: `Too many concurrent subagents (max ${MAX_CONCURRENT_DELEGATIONS}); try again after the current ones finish.`,
        };
      }

      if (total >= MAX_DELEGATIONS_PER_RUN) {
        params.logger.warn('Rejecting delegation: per-run cap reached', {
          code: 'subagent_delegation_per_run_capped',
          personaId: context.primitiveId,
          total,
        });
        return {
          proceed: false,
          rejectionReason: `Subagent delegation limit reached (max ${MAX_DELEGATIONS_PER_RUN} per turn).`,
        };
      }

      inFlight += 1;
      total += 1;
      return {
        modifiedMaxSteps: clampMaxSteps(persona.maxSteps, context.params.maxSteps),
        proceed: true,
      };
    },
  };
}

/**
 * Tracks which delegations have emitted `subagent.started` but not yet a
 * terminal `subagent.finished`/`.failed` run event, so the stream generator can
 * emit a terminal `subagent.failed` (cancelled) event for any delegation still
 * in flight when the parent run is aborted/cancelled — otherwise a cancelled
 * parent leaves an orphaned `subagent.started` with no counterpart, and the
 * reloaded thread renders a forever-"running" subagent.
 */
export interface DelegationLifecycleTracker {
  /** Return AND clear the metadata of every still-in-flight delegation. */
  drainInFlight(): AssistantRunEventMetadata[];
  /** Clear a delegation that reached a terminal run event. */
  settled(parentToolCallId: string): void;
  /** Record a delegation keyed by its parent (delegation) toolCallId. */
  started(parentToolCallId: string, metadata: AssistantRunEventMetadata): void;
}

export function createDelegationLifecycleTracker(): DelegationLifecycleTracker {
  const inFlight = new Map<string, AssistantRunEventMetadata>();
  return {
    drainInFlight() {
      const orphans = Array.from(inFlight.values());
      inFlight.clear();
      return orphans;
    },
    settled(parentToolCallId) {
      inFlight.delete(parentToolCallId);
    },
    started(parentToolCallId, metadata) {
      inFlight.set(parentToolCallId, metadata);
    },
  };
}

/**
 * Whether persona delegation should be enabled for a run. Personas are skipped
 * for the built-in local provider (D10 — the 2B on-device model's prompt budget
 * cannot afford the delegation tool schemas/guidance) and when there are none.
 */
export function shouldEnablePersonas(
  provider: string,
  personas: readonly AssistantPersonaDefinition[] | undefined
): boolean {
  return provider !== 'local' && Boolean(personas && personas.length > 0);
}
