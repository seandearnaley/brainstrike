import type { McpLabFaultExecutionState } from './fault-execution.js';
import type {
  McpLabAuthentication,
  McpLabFault,
  McpLabFaultConsumption,
  McpLabFaultObservation,
  McpLabProtocolEra,
  McpLabProtocolPhase,
  McpLabTransportKind,
} from './faults.js';
import type { McpLabFixture } from './scenario.js';

export interface McpLabFaultPlan {
  assertCompatibleWithAuthentication(authentication: McpLabAuthentication): void;
  assertCompatibleWithFixture(fixture: McpLabFixture): void;
  assertCompatibleWithProtocolEra(era: McpLabProtocolEra): void;
  assertCompatibleWithTransport(transport: McpLabTransportKind): void;
  assertFullyConsumed(): void;
  consume(consumption: McpLabFaultConsumption): McpLabFault;
  consumeIfConfigured(consumption: McpLabFaultConsumption): McpLabFault | undefined;
  executionState(faultId: string): McpLabFaultExecutionState;
  hasRemainingPhase(phase: McpLabProtocolPhase): boolean;
  /** Hold a delay before session claim; its existing request/session abort still joins it. */
  holdDelay(faultId: string): () => void;
  observations(): readonly McpLabFaultObservation[];
  untriggeredIds(): readonly string[];
}
