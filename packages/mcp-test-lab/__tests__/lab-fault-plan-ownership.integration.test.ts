import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

function createPlan() {
  return createMcpLabFaultPlan([
    {
      fault: { delayMs: 1, kind: 'delay' },
      id: 'single-session-tools-list',
      match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
    },
  ]);
}

describe('MCP fault plan session ownership', () => {
  it('applies the same claim boundary to real scenario startup', async () => {
    const plan = createPlan();
    const lab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: plan,
    });

    try {
      await expect(
        startMcpLabScenario('modern-reference', { execution: 'loopback', faultPlan: plan })
      ).rejects.toThrow(/already claimed by a session/i);
    } finally {
      await lab.close();
    }
  });
});
