import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { HostRunAdmissionRequest, HostTool } from '@brainstrike/agent-host';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../../agent-host-platform/connection';
import { desktopHostSharedTools } from '../../agent-host-platform/desktop-host-shared-tools';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../../agent-host-platform/main-platform';
import { PlatformSelectionSchema } from '../../agent-host-platform/platform-wire';
import { createDesktopMcpPlatformCapabilities } from '../../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../../mcp/remote-runtime';

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
export class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

/**
 * A host thread's tools on the production path: Main admits the run over its
 * platform connection, and the agent host's shared tools execute the admitted
 * descriptors through Main's reads on that same connection.
 */
export async function admitHostTools(
  capabilities: Omit<DesktopPlatformCapabilities, 'mcp'>,
  request: HostRunAdmissionRequest
): Promise<{ readonly close: () => Promise<void>; readonly tools: Record<string, HostTool> }> {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const hostPort = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(mainPort);
  const client = mainPlatformConnection(hostPort);
  const owner = serveDesktopPlatform(server, {
    ...capabilities,
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
  });
  client.listen();
  const close = async (): Promise<void> => {
    try {
      await client.sendRequest('platform/release', { threadId: request.threadId });
    } finally {
      await owner.close();
      client.dispose();
      server.dispose();
      mainPort.close();
      hostPort.close();
    }
  };
  try {
    const selected = PlatformSelectionSchema.parse(
      await client.sendRequest('platform/admit', {
        ...(request.configuration ? { configuration: request.configuration } : {}),
        modelId: request.modelId,
        ...(request.planMode ? { planMode: true } : {}),
        threadId: request.threadId,
      })
    );
    return {
      close,
      tools: desktopHostSharedTools({
        readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
        request: (method, input) => client.sendRequest(method, input),
        resolveTavilyApiKey: async () => undefined,
        selected,
        threadId: request.threadId,
      }),
    };
  } catch (cause) {
    await owner.close();
    client.dispose();
    server.dispose();
    mainPort.close();
    hostPort.close();
    throw cause;
  }
}
