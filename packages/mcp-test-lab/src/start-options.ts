import type { McpLabFaultPlan } from './faults.js';

export interface StartMcpLabScenarioOptions {
  readonly execution?: 'in-process' | 'loopback';
  readonly faultPlan?: McpLabFaultPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertStartOptions(
  options: unknown
): asserts options is StartMcpLabScenarioOptions {
  if (!isRecord(options)) {
    throw new Error('Invalid MCP lab start options: expected an object');
  }
  const unknownKey = Object.keys(options).find((key) => key !== 'execution' && key !== 'faultPlan');
  if (unknownKey) {
    throw new Error(`Invalid MCP lab start options: unknown field "${unknownKey}"`);
  }
  const execution = options['execution'];
  if (execution !== undefined && execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process" or "loopback"');
  }
  const faultPlan = options['faultPlan'];
  if (faultPlan === undefined) {
    return;
  }
  const requiredMethods = [
    'assertFullyConsumed',
    'consume',
    'consumeIfConfigured',
    'hasRemainingPhase',
    'observations',
    'untriggeredIds',
  ] as const;
  if (
    !isRecord(faultPlan) ||
    requiredMethods.some((method) => typeof faultPlan[method] !== 'function')
  ) {
    throw new Error(
      'Invalid MCP lab start options: faultPlan must be created by createMcpLabFaultPlan'
    );
  }
}
