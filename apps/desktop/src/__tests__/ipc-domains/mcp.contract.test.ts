import { describe, expect, it } from 'vitest';
import {
  mcpAppsContract,
  mcpContentContract,
  mcpContract,
  mcpElicitationContract,
  mcpPathSelectionContract,
  mcpTasksContract,
} from '../../ipc-domains/mcp.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('MCP IPC contracts', () => {
  const contracts = [
    mcpContract,
    mcpPathSelectionContract,
    mcpContentContract,
    mcpElicitationContract,
    mcpAppsContract,
    mcpTasksContract,
  ];

  it('owns all 31 invokes and seven pushes in the desktop MCP manifest', () => {
    const specs = contracts.flatMap((contract) => Object.values(contract));
    expect(specs.filter(({ kind }) => kind === 'invoke')).toHaveLength(31);
    expect(specs.filter(({ kind }) => kind === 'push')).toHaveLength(7);
    expect(new Set(specs.map(({ channel }) => channel))).toEqual(
      new Set(Object.values(DESKTOP_IPC_CHANNELS.mcp))
    );
  });

  it('authorizes every invoke for visible UI and preserves raw replies', () => {
    for (const contract of contracts) {
      for (const spec of Object.values(contract)) {
        if (spec.kind === 'invoke') {
          expect(spec.roles).toEqual(['visible-ui']);
          expect(spec.envelope).toBe('raw');
        }
      }
    }
  });

  it('rejects malformed primitive tuples before handlers run', () => {
    expect(() => mcpContract.enableTools.parseArgs([['ok', 1]])).toThrow(
      'MCP enable tools requires an array of strings'
    );
    expect(() => mcpContract.setPath.parseArgs([false])).toThrow(
      'MCP config path requires a string or null'
    );
    expect(mcpContract.getConfig.parseArgs(['extra'])).toEqual([]);
  });
});
