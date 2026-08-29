import type {
  McpLabFault,
  McpLabFaultPlan,
  McpLabProtocolMethod,
  McpLabProtocolPhase,
} from './faults.js';
import { HTTP_PROTOCOL_COORDINATE_PHASES } from './http-coordinates.js';

export interface McpLabAppliedFault {
  readonly fault: McpLabFault;
  readonly id: string;
}

export interface McpLabFaultRuntime {
  consume(
    phase: McpLabProtocolPhase,
    method: McpLabProtocolMethod,
    correlationId: string
  ): McpLabAppliedFault | undefined;
  nextCorrelation(label?: string): string;
  requiresProtocolBodyCoordinate(): boolean;
  untriggeredIds(): readonly string[];
}

export class McpLabDroppedResponseError extends Error {
  readonly faultId: string;

  constructor(faultId: string) {
    super(`MCP lab fault "${faultId}" dropped the response`);
    this.faultId = faultId;
    this.name = 'McpLabDroppedResponseError';
  }
}

export function createMcpLabFaultRuntime(
  plan: McpLabFaultPlan | undefined,
  scenarioId: string
): McpLabFaultRuntime {
  const occurrences = new Map<string, number>();
  let correlationSequence = 0;
  return Object.freeze({
    consume(
      phase: McpLabProtocolPhase,
      method: McpLabProtocolMethod,
      correlationId: string
    ): McpLabAppliedFault | undefined {
      if (!plan) {
        return;
      }
      const key = `${phase}\u0000${method}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      const fault = plan.consumeIfConfigured({ correlationId, method, occurrence, phase });
      if (!fault) {
        return;
      }
      const observation = plan.observations().at(-1);
      if (
        !observation ||
        observation.correlationId !== correlationId ||
        observation.method !== method ||
        observation.phase !== phase ||
        observation.occurrence !== occurrence
      ) {
        throw new Error(`MCP lab fault observation missing for ${phase}/${method}`);
      }
      return Object.freeze({ fault, id: observation.faultId });
    },
    nextCorrelation(label = 'exchange'): string {
      correlationSequence += 1;
      return `${scenarioId}:${label}:${correlationSequence}`;
    },
    requiresProtocolBodyCoordinate(): boolean {
      return (
        plan !== undefined &&
        HTTP_PROTOCOL_COORDINATE_PHASES.some((phase) => plan.hasRemainingPhase(phase))
      );
    },
    untriggeredIds(): readonly string[] {
      return plan?.untriggeredIds() ?? Object.freeze([]);
    },
  });
}

export async function applyMcpLabHttpFault(
  applied: McpLabAppliedFault
): Promise<Response | undefined> {
  switch (applied.fault.kind) {
    case 'delay': {
      const { delayMs } = applied.fault;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    case 'drop_response':
      throw new McpLabDroppedResponseError(applied.id);
    case 'http_status':
      return Response.json(
        { error: 'mcp_lab_fault', faultId: applied.id },
        { status: applied.fault.status }
      );
    case 'malformed_json':
      return new Response(applied.fault.payload, {
        headers: { 'content-type': 'application/json' },
      });
    case 'cleanup_error':
    case 'child_exit':
    case 'child_stderr':
      throw new Error(`MCP lab fault "${applied.id}" cannot target an HTTP exchange`);
    default: {
      const unsupported: never = applied.fault;
      throw new Error(`Unsupported MCP lab HTTP fault: ${String(unsupported)}`);
    }
  }
}
