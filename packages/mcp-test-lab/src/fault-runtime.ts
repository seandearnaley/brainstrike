import type {
  McpLabFault,
  McpLabFaultPlan,
  McpLabProtocolMethod,
  McpLabProtocolPhase,
} from './faults.js';
import { isMcpLabCorrelationId } from './faults.js';
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
  hasRemainingPhase(phase: McpLabProtocolPhase): boolean;
  nextCorrelation(label?: string): string;
  requiresHttpQualification(): boolean;
  requiresProtocolBodyCoordinate(): boolean;
  reserveCorrelation(supplied?: string, label?: string): string;
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

export class McpLabCorrelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpLabCorrelationError';
  }
}

export function createMcpLabFaultRuntime(
  plan: McpLabFaultPlan | undefined,
  scenarioId: string
): McpLabFaultRuntime {
  const occurrences = new Map<string, number>();
  const reservedCorrelations = new Set<string>();
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
    hasRemainingPhase(phase: McpLabProtocolPhase): boolean {
      return plan?.hasRemainingPhase(phase) ?? false;
    },
    nextCorrelation(label = 'exchange'): string {
      return this.reserveCorrelation(undefined, label);
    },
    requiresHttpQualification(): boolean {
      return (
        plan !== undefined &&
        (
          ['authorization', 'initialization', 'operation', 'subscription', 'transport'] as const
        ).some((phase) => plan.hasRemainingPhase(phase))
      );
    },
    requiresProtocolBodyCoordinate(): boolean {
      return (
        plan !== undefined &&
        HTTP_PROTOCOL_COORDINATE_PHASES.some((phase) => plan.hasRemainingPhase(phase))
      );
    },
    reserveCorrelation(supplied: string | undefined, label = 'exchange'): string {
      let correlationId = supplied;
      if (correlationId === undefined) {
        correlationSequence += 1;
        correlationId = `${scenarioId}:${label}:${correlationSequence}`;
      }
      if (!isMcpLabCorrelationId(correlationId)) {
        throw new McpLabCorrelationError('Invalid MCP lab correlation id');
      }
      if (reservedCorrelations.has(correlationId)) {
        throw new McpLabCorrelationError(`Duplicate MCP lab correlation id: ${correlationId}`);
      }
      reservedCorrelations.add(correlationId);
      return correlationId;
    },
    untriggeredIds(): readonly string[] {
      return plan?.untriggeredIds() ?? Object.freeze([]);
    },
  });
}

export async function applyMcpLabHttpFault(
  applied: McpLabAppliedFault,
  displacedResponse?: Response
): Promise<Response | undefined> {
  if (applied.fault.kind !== 'delay' && displacedResponse?.body) {
    await displacedResponse.body.cancel();
  }
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
