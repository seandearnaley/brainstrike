import { describe, expect, it } from 'vitest';
import { mcpAppsContract, mcpPathSelectionContract } from '../../ipc-domains/mcp.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('MCP IPC contracts', () => {
  const contracts = [mcpPathSelectionContract, mcpAppsContract];

  it('binds every desktop MCP manifest method as an invoke, with no pushes', () => {
    const specs = contracts.flatMap((contract) => Object.values(contract));
    expect(specs.filter(({ kind }) => kind === 'push')).toEqual([]);
    expect(new Set(specs.map(({ channel }) => channel))).toEqual(
      new Set(Object.values(DESKTOP_IPC_CHANNELS.mcp))
    );
  });

  it('preserves raw replies for every invoke', () => {
    for (const contract of contracts) {
      for (const spec of Object.values(contract)) {
        if (spec.kind === 'invoke') {
          expect(spec.envelope).toBe('raw');
        }
      }
    }
  });
});
