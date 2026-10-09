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

  it('owns all 14 invokes and four pushes in the desktop MCP manifest', () => {
    const specs = contracts.flatMap((contract) => Object.values(contract));
    expect(specs.filter(({ kind }) => kind === 'invoke')).toHaveLength(14);
    expect(specs.filter(({ kind }) => kind === 'push')).toHaveLength(4);
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

  it('rejects malformed tuples before handlers run', () => {
    expect(() => mcpContract.controlServer.parseArgs([])).toThrow();
    expect(mcpContract.getServerStatusSnapshot.parseArgs(['extra'])).toEqual([]);
  });

  // BST-1930 c5a: the agent host owns MCP config, extension dials and tool
  // preferences; the renderer reaches them as host methods, never Main channels.
  it('leaves MCP settings off the desktop IPC manifest', () => {
    const channels = Object.values(DESKTOP_IPC_CHANNELS.mcp);
    expect(channels.filter((channel) => /^mcp:(tools|extensions):/u.test(channel))).toEqual([]);
    expect(channels.filter((channel) => channel.startsWith('mcp:config:'))).toEqual([
      'mcp:config:selectPath',
    ]);
  });
});
