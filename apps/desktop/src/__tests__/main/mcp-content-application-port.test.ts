import type {
  McpHostCatalog,
  McpHostCloseReport,
  McpHostOperation,
} from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  createMcpContentApplicationPort,
  type McpContentApplicationRequest,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import type { ResolvedMcpConfig } from '../../mcp-loader';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const CLEAN: McpHostCloseReport = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
};
const CATALOG: McpHostCatalog = {
  errors: {},
  features: {
    completion: true,
    promptListChanged: false,
    prompts: true,
    resourceListChanged: false,
    resourceSubscriptions: false,
    resources: true,
    toolListChanged: false,
    tools: true,
  },
  subscription: { mode: 'none', state: 'unsupported' },
};
type Runtime = ReturnType<typeof createDesktopMcpHostRuntime>;
type Invoke = (
  operation: McpHostOperation,
  options: { signal: AbortSignal },
  generation: number
) => Promise<unknown>;
function config(url?: string): ResolvedMcpConfig {
  return {
    servers: url
      ? [
          {
            name: SERVER_ID,
            protocol: 'auto',
            startup: 'automatic',
            transport: 'streamable-http',
            url,
          },
        ]
      : [],
  };
}
function result(operation: McpHostOperation): unknown {
  if (operation.type !== 'resources/read') {
    throw new Error(`Unexpected Desktop MCP content operation: ${operation.type}`);
  }
  return { contents: [{ text: '# BST-1578', uri: operation.uri }] };
}
function runtime(invoke: Invoke = async (operation) => result(operation)): Runtime {
  return createDesktopMcpHostRuntime({
    createActorClient: (_server, context) => ({
      catalog: () => CATALOG,
      close: vi.fn(async () => CLEAN),
      invoke: vi.fn(
        async (operation, options) => await invoke(operation, options, context.generation)
      ),
      negotiated: { era: 'modern', revision: '2026-07-28' },
    }),
    onInternalError: vi.fn(),
  });
}
async function ready(
  target: Runtime,
  url = 'https://linear.example/first'
): Promise<McpContentApplicationRequest> {
  await target.replaceResolvedConfig(config(url));
  await target.host.control({ action: 'connect', configuredServerId: SERVER_ID });
  const server = target.host.snapshot().servers[0];
  if (server?.state !== 'connected') {
    throw new Error('Expected connected Desktop MCP content authority');
  }
  return {
    authority: { configuredServerId: server.configuredServerId, generation: server.generation },
    type: 'resources/read',
    uri: 'linear://issue/BST-1578',
  };
}
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  );
}
describe('MCP content application port over DesktopMcpHostRuntime (BST-1578)', () => {
  it('maps terminal close and leaves no application watch registered', async () => {
    const target = runtime();
    const request = await ready(target);
    const port = createMcpContentApplicationPort(target.host);
    const close = await target.host.close();
    await expect(port.execute(request)).rejects.toMatchObject({
      code: 'mcp_content_host_operation_failed',
      hostError: { category: 'host-closed', code: 'mcp-host-closed' },
    });
    expect(close.subscriptionsClosed).toBe(0);
  });
  it('retires accepted work during real config replacement', async () => {
    let invocationSignal: AbortSignal | undefined;
    const target = runtime(async (operation, options, generation) => {
      if (generation !== 1) {
        return result(operation);
      }
      invocationSignal = options.signal;
      return await rejectOnAbort(options.signal);
    });
    const request = await ready(target);
    const pending = createMcpContentApplicationPort(target.host).execute(request);
    await vi.waitFor(() => expect(invocationSignal).toBeDefined());
    const replacement = target.replaceResolvedConfig(config('https://linear.example/next'));
    await expect(pending).rejects.toMatchObject({ code: 'mcp_content_generation_retired' });
    await replacement;
    expect(target.host.snapshot().servers[0]?.generation).toBeGreaterThan(
      request.authority.generation
    );
    await target.host.close();
  });
  it('rejects pre-reset authority after empty config', async () => {
    const target = runtime();
    const request = await ready(target);
    const port = createMcpContentApplicationPort(target.host);
    await target.replaceResolvedConfig(config());
    await expect(port.execute(request)).rejects.toMatchObject({
      code: 'mcp_content_server_unknown',
    });
    await target.host.close();
  });
  it('unwatches before queued replacement delivery', async () => {
    let target: Runtime;
    const replaced = Promise.withResolvers<void>();
    target = runtime(async (operation, _options, generation) => {
      if (generation === 1) {
        setImmediate((): void => {
          void target
            .replaceResolvedConfig(config('https://linear.example/next'))
            .then(() => replaced.resolve());
        });
      }
      return result(operation);
    });
    const request = await ready(target);
    const pending = createMcpContentApplicationPort(target.host).execute(request);
    await expect(pending).resolves.toMatchObject({
      type: 'resources/read',
    });
    await replaced.promise;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect((await target.host.close()).subscriptionsClosed).toBe(0);
  });
});
