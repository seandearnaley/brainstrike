import type { TelemetryOptions } from 'ai';

/** The host's AI SDK calls, as `gen_ai.agent.name` on their `invoke_agent` spans. */
export type HostTelemetryFunction =
  | 'brainstrike.context-compaction'
  | 'brainstrike.host-run'
  | 'brainstrike.thread-title';

export interface HostTelemetryIds {
  readonly id: string;
  readonly threadId: string;
}

interface HostRuntimeContext extends Record<string, unknown> {
  readonly runId: string;
  readonly threadId: string;
}

// Keep this module free of runtime imports: thread-presentation-state imports
// it, and the browser web writer bundles that. Only startHostTracing (Node,
// ./otel.ts) writes the flag, before the host's first run.
let recordContent = false;

/** `BRAINSTRIKE_OTEL_RECORD_CONTENT=1`: prompts, responses and tool payloads join the spans. */
export function configureHostTelemetryContent(record: boolean): void {
  recordContent = record;
}

/**
 * Per-call AI SDK telemetry: the call's function id, its run and thread ids as
 * `ai.settings.context.*` span attributes, and no prompt, response or tool
 * payload unless content recording was configured. The SDK records content by
 * default, so every host-owned `streamText`/`generateText` call spreads this.
 * Inert while no telemetry integration is registered.
 */
export function hostTelemetry(
  functionId: HostTelemetryFunction,
  run: HostTelemetryIds
): {
  readonly runtimeContext: HostRuntimeContext;
  readonly telemetry: TelemetryOptions<HostRuntimeContext>;
} {
  return {
    runtimeContext: { runId: run.id, threadId: run.threadId },
    telemetry: {
      functionId,
      includeRuntimeContext: { runId: true, threadId: true },
      recordInputs: recordContent,
      recordOutputs: recordContent,
    },
  };
}
