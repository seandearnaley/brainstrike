import { isMcpLabFaultPlan, type McpLabFaultPlan } from './faults.js';

export interface StartMcpLabScenarioOptions {
  readonly execution?: 'in-process' | 'loopback';
  readonly faultPlan?: McpLabFaultPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStartOptions(options: unknown): Readonly<StartMcpLabScenarioOptions> {
  if (!isRecord(options)) {
    throw new Error('Invalid MCP lab start options: expected an object');
  }
  const unknownKey = Object.keys(options).find((key) => key !== 'execution' && key !== 'faultPlan');
  if (unknownKey) {
    throw new Error(`Invalid MCP lab start options: unknown field "${unknownKey}"`);
  }
  let execution: unknown;
  let faultPlan: unknown;
  try {
    execution = options['execution'];
    faultPlan = options['faultPlan'];
  } catch {
    throw new Error('Invalid MCP lab start options: could not snapshot input');
  }
  if (execution !== undefined && execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process" or "loopback"');
  }
  if (faultPlan !== undefined && !isMcpLabFaultPlan(faultPlan)) {
    throw new Error(
      'Invalid MCP lab start options: faultPlan must be created by createMcpLabFaultPlan'
    );
  }
  return Object.freeze({
    ...(execution === undefined ? {} : { execution }),
    ...(faultPlan === undefined ? {} : { faultPlan }),
  });
}
