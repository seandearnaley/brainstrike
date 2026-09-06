import type { McpLabFaultExecution } from './fault-execution.js';
import type {
  McpLabFault,
  McpLabFaultConsumption,
  McpLabFaultMatch,
  McpLabFaultObservation,
  McpLabFaultPlan,
  McpLabProtocolPhase,
} from './faults.js';

export const MCP_LAB_CLAIMED_PLAN = Symbol('MCP_LAB_CLAIMED_PLAN');

export interface McpLabClaimedFaultPlan {
  beginExecution(faultId: string): McpLabFaultExecution;
  configuredFault(match: McpLabFaultMatch): McpLabFault | undefined;
  consume(consumption: McpLabFaultConsumption): McpLabFault;
  consumeIfConfigured(consumption: McpLabFaultConsumption): McpLabFault | undefined;
  hasRemainingPhase(phase: McpLabProtocolPhase): boolean;
  observations(): readonly McpLabFaultObservation[];
  untriggeredIds(): readonly string[];
  readonly [MCP_LAB_CLAIMED_PLAN]: true;
}

const CLAIMS = new WeakMap<McpLabFaultPlan, () => McpLabClaimedFaultPlan>();

export function registerMcpLabFaultPlanClaim(
  plan: McpLabFaultPlan,
  claim: () => McpLabClaimedFaultPlan
): void {
  CLAIMS.set(plan, claim);
}

export function isRegisteredMcpLabFaultPlan(value: unknown): value is McpLabFaultPlan {
  return typeof value === 'object' && value !== null && CLAIMS.has(value as McpLabFaultPlan);
}

export function claimMcpLabFaultPlan(
  plan: McpLabFaultPlan | undefined
): McpLabClaimedFaultPlan | undefined {
  if (plan === undefined) {
    return;
  }
  const claim = CLAIMS.get(plan);
  if (!claim) {
    throw new Error('Invalid MCP lab fault plan');
  }
  return claim();
}

export function startWithClaimedMcpLabFaultPlan<T>(
  plan: McpLabFaultPlan | undefined,
  allocate: (claimedPlan: McpLabClaimedFaultPlan | undefined) => T
): T {
  const claimedPlan = claimMcpLabFaultPlan(plan);
  return allocate(claimedPlan);
}
