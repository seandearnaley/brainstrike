import type { McpLabFaultPlan, McpLabTransportKind } from './faults.js';
import type { McpLabScenario } from './scenario.js';
import type { StartMcpLabScenarioOptions } from './start-options.js';

function transportForScenario(
  scenario: McpLabScenario,
  execution: StartMcpLabScenarioOptions['execution']
): McpLabTransportKind {
  if (scenario.id === 'stdio-reference') {
    return 'stdio';
  }
  return execution === 'in-process' ? 'http-in-process' : 'http-loopback';
}

export function assertScenarioFaultCompatibility(
  faultPlan: McpLabFaultPlan | undefined,
  scenario: McpLabScenario,
  execution: StartMcpLabScenarioOptions['execution']
): void {
  if (!faultPlan) {
    return;
  }
  faultPlan.assertCompatibleWithAuthentication(scenario.authentication);
  faultPlan.assertCompatibleWithProtocolEra(scenario.protocol.era);
  faultPlan.assertCompatibleWithTransport(transportForScenario(scenario, execution));
  faultPlan.assertCompatibleWithFixture(scenario.fixture);
}
