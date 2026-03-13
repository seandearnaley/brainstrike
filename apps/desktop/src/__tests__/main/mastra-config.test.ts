import { describe, expect, it } from 'vitest';
import {
  filterDesktopMastraMcpConfig,
  isDesktopFilesystemBridgeServer,
} from '../../mcp/mastra-config';

describe('mastra MCP desktop config helpers', () => {
  it('identifies the local desktop filesystem bridge server', () => {
    expect(
      isDesktopFilesystemBridgeServer({
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        command: 'npx',
        name: 'filesystem',
        transport: 'stdio',
      })
    ).toBe(true);
    expect(
      isDesktopFilesystemBridgeServer({
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        command: 'npx',
        name: 'Filesystem',
        transport: 'stdio',
      })
    ).toBe(true);
    expect(
      isDesktopFilesystemBridgeServer({
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        command: 'npx',
        name: 'filesystem',
        transport: 'sse',
      })
    ).toBe(false);
    expect(
      isDesktopFilesystemBridgeServer({
        args: ['/tmp'],
        command: 'node',
        name: 'filesystem',
        transport: 'stdio',
      })
    ).toBe(false);
  });

  it('filters filesystem bridge servers out of Mastra discovery config', () => {
    expect(
      filterDesktopMastraMcpConfig({
        servers: [
          {
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            command: 'npx',
            name: 'filesystem',
            transport: 'stdio',
          },
          { name: 'remote-api', transport: 'sse' },
        ],
      })
    ).toEqual({
      servers: [{ name: 'remote-api', transport: 'sse' }],
    });
  });

  it('returns undefined when only filesystem bridge servers remain', () => {
    expect(
      filterDesktopMastraMcpConfig({
        servers: [
          {
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            command: 'npx',
            name: 'filesystem',
            transport: 'stdio',
          },
        ],
      })
    ).toBeUndefined();
  });
});
