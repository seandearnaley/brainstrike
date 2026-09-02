import { EventEmitter } from 'node:events';
import type { McpAppToolAdmissionCapability } from '@brainstrike/agent';
import type { McpAppPrepareRequest } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { McpDesktopAppHost, type McpDesktopAppHostError } from '../../mcp/apps-authority';

class FakeWebContents extends EventEmitter {
  private destroyed = false;
  constructor(readonly id: number) {
    super();
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const request = (preparationId: string): McpAppPrepareRequest => ({
  arguments: { title: 'Issue' },
  origin: {
    mimeType: 'text/html;profile=mcp-app',
    resourceUri: 'ui://linear/editor',
    serverId: 'linear',
    toolName: 'open_editor',
  },
  preparationId,
  toolName: 'create_issue',
});

function admission(execute = vi.fn(async () => ({ content: [{ text: 'ok', type: 'text' }] }))) {
  const capability: McpAppToolAdmissionCapability = {
    admit: vi.fn(() => ({
      decision: 'allow' as const,
      execute,
      riskCategory: 'mcp' as const,
    })),
    inadmissibleTools: [],
    serverIds: ['linear'],
  };
  return { capability, execute };
}

describe('McpDesktopAppHost', () => {
  it('prepares and executes one live-run ordinary call', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(41);
    const ordinary = admission();
    host.registerAdmission('run-1', ordinary.capability);

    await expect(host.prepare(sender, request('prep-1'))).resolves.toEqual({
      decision: 'allow',
      riskCategory: 'mcp',
    });
    await expect(host.execute(sender, { preparationId: 'prep-1' })).resolves.toEqual({
      result: { content: [{ text: 'ok', type: 'text' }] },
    });
    expect(ordinary.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects execute without prepare, replay, and execute after release', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(42);
    host.registerAdmission('run-1', admission().capability);

    await expect(host.execute(sender, { preparationId: 'missing' })).rejects.toThrow(
      /not available/u
    );
    await host.prepare(sender, request('once'));
    await host.execute(sender, { preparationId: 'once' });
    await expect(host.execute(sender, { preparationId: 'once' })).rejects.toThrow(/not available/u);
    await host.prepare(sender, request('released'));
    await host.release(sender, { preparationId: 'released' });
    await expect(host.execute(sender, { preparationId: 'released' })).rejects.toThrow(
      /not available/u
    );
  });

  it('fails closed with the typed no-live-run error', async () => {
    const host = new McpDesktopAppHost();
    await expect(host.prepare(new FakeWebContents(43), request('prep'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    } satisfies Partial<McpDesktopAppHostError>);
  });

  it('never prepares through an invalidated run admission', async () => {
    const host = new McpDesktopAppHost();
    host.registerAdmission('run-stale', admission().capability);
    host.invalidateAdmission('run-stale');

    await expect(host.prepare(new FakeWebContents(45), request('stale'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    });
  });

  it('force-releases a sender entries when its WebContents is destroyed', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(44);
    host.registerAdmission('run-1', admission().capability);
    await host.prepare(sender, request('destroyed'));

    sender.destroy();

    await expect(host.execute(sender, { preparationId: 'destroyed' })).rejects.toThrow(
      /not available/u
    );
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
});
