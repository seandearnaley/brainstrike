import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { HostRunAdmissionRequest, HostTool } from '@brainstrike/agent-host';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../../agent-host-platform/connection';
import { desktopHostSharedTools } from '../../agent-host-platform/desktop-host-shared-tools';
import { mainAdmissionReads } from '../../agent-host-platform/desktop-node-platform';
import { createDesktopRunAdmission } from '../../agent-host-platform/desktop-run-admission';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../../agent-host-platform/main-platform';
import { createDesktopMcpPlatformCapabilities } from '../../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../../mcp/main-host-control';

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
 * A host thread's tools on the production path: the host admits the run from
 * Main's reads over its platform connection, and the host's shared tools
 * execute the admitted descriptors through Main's reads on that connection.
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
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  client.listen();
  const send = (method: string, input: unknown): Promise<unknown> =>
    client.sendRequest(method, input);
  const release = async (): Promise<void> => {
    await owner.close();
    client.dispose();
    server.dispose();
    mainPort.close();
    hostPort.close();
  };
  try {
    const selected = await createDesktopRunAdmission(mainAdmissionReads(send)).readConfiguration(
      request
    );
    return {
      close: async () => {
        try {
          await selected.close();
        } finally {
          await release();
        }
      },
      tools: desktopHostSharedTools({
        freshRoots: () => selected.freshWorkspaceRoots(),
        readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
        request: send,
        resolveTavilyApiKey: async () => undefined,
        selected,
        threadId: request.threadId,
      }),
    };
  } catch (cause) {
    await release();
    throw cause;
  }
}
