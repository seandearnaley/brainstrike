import type { McpAppBridge, McpAppOrigin } from '@brainstrike/assistant-contract';
import { parseMcpAppPrepareRequest } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  McpAppFrameBridge,
  type McpAppFrameEventTarget,
  type McpAppFrameSource,
  type McpAppGeneration,
  McpAppProvenanceAuthority,
  McpAppSandboxOwner,
  type McpAppSandboxUrlApi,
  McpAppToolCallAuthority,
  type McpAppToolRiskCategory,
} from '@brainstrike/mcp-app-host';
import { type McpAppHostState, McpAppHostSurface } from '@brainstrike/mcp-app-host-ui';
import {
  type ComponentProps,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ToolFallback } from './tool-fallback';
import { useMcpAppBridge } from './use-mcp-app-bridge';

const logger = createLogger('McpAppToolResult');

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const DEFAULT_HOST_VERSION = '1.0.0';
const FRAME_READY_TIMEOUT_MS = 10_000;
const FRAME_POLL_INTERVAL_MS = 20;

const RISK_CATEGORIES: readonly McpAppToolRiskCategory[] = ['edit', 'execute', 'mcp', 'read'];

/**
 * Host-side ports the app runtime needs. Injectable so the renderer can be
 * exercised without a real nested-srcdoc frame; the default reads the live
 * window, the live `URL` object-store, and the sandbox shell's nested app
 * frame exactly as the packaged lifecycle proof does.
 */
export interface McpAppRuntimePorts {
  readonly eventTarget: McpAppFrameEventTarget;
  readonly resolveFrameSource: (frame: HTMLIFrameElement) => McpAppFrameSource | undefined;
  readonly urls: McpAppSandboxUrlApi;
}

/** Handles for an app session that reached the frame-connected state. */
export interface McpAppMountedSession {
  readonly authority: McpAppToolCallAuthority;
  readonly frameBridge: McpAppFrameBridge;
  readonly sandboxOwner: McpAppSandboxOwner;
}

export interface McpAppToolResultProps {
  readonly app: McpAppOrigin;
  readonly hostVersion?: string;
  /** Observation seam: the live session, then `undefined` once teardown settles. */
  readonly onSessionChange?: (session: McpAppMountedSession | undefined) => void;
  readonly ports?: McpAppRuntimePorts;
  /** The ordinary tool result, rendered when this host cannot host apps. */
  readonly toolCall: ComponentProps<typeof ToolFallback>;
}

function createDefaultRuntimePorts(): McpAppRuntimePorts {
  return {
    eventTarget: window,
    resolveFrameSource: (frame) =>
      frame.contentDocument?.querySelector('iframe')?.contentWindow ?? undefined,
    urls: {
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
    },
  };
}

function initializeResult(hostVersion: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    hostCapabilities: Object.freeze({}),
    hostContext: Object.freeze({ platform: 'desktop' }),
    hostInfo: Object.freeze({ name: 'Brainstrike', version: hostVersion }),
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
  });
}

/** NO SILENT FALLBACK: an unknown risk category is a broken host contract. */
function parseRiskCategory(value: string): McpAppToolRiskCategory {
  const category = RISK_CATEGORIES.find((candidate) => candidate === value);
  if (category === undefined) {
    throw new TypeError(`MCP Apps prepare returned an unknown risk category "${value}"`);
  }
  return category;
}

interface McpAppView {
  readonly shellUrl?: string;
  readonly state: McpAppHostState;
}

interface AppSession {
  readonly authority: McpAppToolCallAuthority;
  readonly generation: McpAppGeneration;
  readonly provenance: McpAppProvenanceAuthority;
  readonly resourceValue: (html: string) => Readonly<Record<string, unknown>>;
  readonly tool: ReturnType<McpAppProvenanceAuthority['registerTool']>;
}

/**
 * A renderer-local provenance + tool-call authority for ONE app mount. The
 * generation is per-mount (a fresh provenance authority per mount, opened at
 * generation 1), so a remount never replays a retired generation's ownership.
 * `prepare`/`execute`/`release` are the host bridge's admission contract: the
 * renderer never talks to the MCP server itself.
 */
function createAppSession(app: McpAppOrigin, bridge: McpAppBridge): AppSession {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: app.serverId });
  const tool = provenance.registerTool(generation, {
    _meta: { ui: { resourceUri: app.resourceUri } },
    name: app.toolName,
  });
  const authority = new McpAppToolCallAuthority({
    generation,
    onDiagnostic: (error) => logger.warn('MCP app tool call failed', { error: error.message }),
    prepare: async (call, context) => {
      const prepared = await bridge.prepare(
        parseMcpAppPrepareRequest({
          arguments: call.input,
          origin: app,
          preparationId: context.id,
          toolName: call.toolName,
        })
      );
      return {
        decision: prepared.decision,
        execute: async () => (await bridge.execute({ preparationId: context.id })).result,
        riskCategory: parseRiskCategory(prepared.riskCategory),
      };
    },
    provenance,
    release: async (_call, context) => {
      await bridge.release({ preparationId: context.id });
    },
  });
  return {
    authority,
    generation,
    provenance,
    resourceValue: (html) => ({ mimeType: app.mimeType, text: html, uri: app.resourceUri }),
    tool,
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitFrameSource(
  read: () => McpAppFrameSource | undefined,
  isDisposed: () => boolean
): Promise<McpAppFrameSource> {
  const deadline = Date.now() + FRAME_READY_TIMEOUT_MS;
  for (;;) {
    if (isDisposed()) {
      throw new Error('MCP Apps mount was torn down before the app frame appeared');
    }
    const source = read();
    if (source !== undefined) {
      return source;
    }
    if (Date.now() > deadline) {
      throw new Error('MCP Apps sandbox frame never became available');
    }
    await delay(FRAME_POLL_INTERVAL_MS);
  }
}

function LiveMcpApp({
  app,
  hostVersion = DEFAULT_HOST_VERSION,
  bridge,
  onSessionChange,
  ports,
}: {
  readonly app: McpAppOrigin;
  readonly bridge: McpAppBridge;
  readonly hostVersion?: string;
  readonly onSessionChange?: (session: McpAppMountedSession | undefined) => void;
  readonly ports?: McpAppRuntimePorts;
}): ReactElement {
  const runtimePorts = useMemo(() => ports ?? createDefaultRuntimePorts(), [ports]);
  const [session] = useState(() => createAppSession(app, bridge));
  // ONE state cell: the surface phase and the shell URL always move together,
  // so no render ever shows a ready surface without its frame (or the reverse).
  const [view, setView] = useState<McpAppView>({ state: { phase: 'loading' } });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const sessionChangeRef = useRef(onSessionChange);
  useEffect(() => {
    sessionChangeRef.current = onSessionChange;
  }, [onSessionChange]);

  useEffect(() => {
    let disposed = false;
    let frameBridge: McpAppFrameBridge | undefined;
    const sandboxOwner = new McpAppSandboxOwner({ urls: runtimePorts.urls });

    const fail = (code: 'load-failed' | 'protocol-failed'): void =>
      setView({ state: { code, phase: 'error' } });

    const start = async (): Promise<void> => {
      const html = await bridge.readResource(app);
      if (disposed) {
        return;
      }
      const resource = session.provenance.resolveResource(
        session.generation,
        session.tool,
        session.resourceValue(html)
      );
      const mount = sandboxOwner.open(resource);
      setView({ shellUrl: mount.shellUrl, state: { phase: 'ready' } });
      const source = await awaitFrameSource(
        () => {
          const frame = frameRef.current;
          return frame === null ? undefined : runtimePorts.resolveFrameSource(frame);
        },
        () => disposed
      );
      if (disposed) {
        return;
      }
      const connected = new McpAppFrameBridge({
        eventTarget: runtimePorts.eventTarget,
        isGenerationLive: (value) => !disposed && value === session.generation.generation,
        onNotification: () => undefined,
        onProtocolError: (error) => {
          if (disposed) {
            return;
          }
          logger.warn('MCP app protocol error', { error: error.message });
          fail('protocol-failed');
        },
        onRequest: async (message, context) => {
          if (message.method === 'ui/initialize') {
            return initializeResult(hostVersion);
          }
          if (message.method !== 'tools/call') {
            return {};
          }
          return await session.authority.call(
            {
              arguments: message.params?.['arguments'] ?? {},
              id: message.id,
              name: message.params?.['name'],
            },
            { signal: context.signal }
          );
        },
      });
      frameBridge = connected;
      connected.connect({
        generation: session.generation.generation,
        origin: 'null',
        source,
      });
      sessionChangeRef.current?.({
        authority: session.authority,
        frameBridge: connected,
        sandboxOwner,
      });
    };

    void start().catch((error: unknown) => {
      if (disposed) {
        return;
      }
      logger.warn('MCP app failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
      fail('load-failed');
    });

    return () => {
      disposed = true;
      void (async () => {
        frameBridge?.close();
        await session.authority.close();
        try {
          session.provenance.retireGeneration(session.generation);
        } catch (error: unknown) {
          logger.warn('MCP app generation retirement failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await sandboxOwner.closeAll();
        sessionChangeRef.current?.(undefined);
      })();
    };
  }, [app, bridge, hostVersion, runtimePorts, session]);

  return (
    <div className="my-1 max-w-xl" ref={recoveryRef} tabIndex={-1}>
      <McpAppHostSurface
        appName={app.toolName}
        authority={session.authority}
        recoveryFocusRef={recoveryRef}
        state={view.state}
      >
        {view.shellUrl === undefined ? null : (
          <iframe
            aria-label={`${app.toolName} app`}
            className="h-64 w-full rounded-lg border-0"
            data-mcp-app-sandbox="true"
            key={view.shellUrl}
            ref={frameRef}
            src={view.shellUrl}
            title={`${app.toolName} app`}
          />
        )}
      </McpAppHostSurface>
    </div>
  );
}

/**
 * Renders an MCP App tool result (BST-1572). With no host bridge the ordinary
 * result is rendered through {@link ToolFallback} plus a visible note — the
 * host's inability to run apps is stated, never silently swallowed.
 */
export function McpAppToolResult({
  app,
  hostVersion,
  onSessionChange,
  ports,
  toolCall,
}: McpAppToolResultProps): ReactElement {
  const bridge = useMcpAppBridge();
  if (bridge === null) {
    return (
      <div className="my-1">
        <ToolFallback {...toolCall} />
        <p
          className="mt-1 text-muted-foreground text-xs"
          data-testid="mcp-app-host-note"
          role="note"
        >
          App rendering unavailable in this host
        </p>
      </div>
    );
  }
  // A different app origin is a different mount: nothing carries over.
  return (
    <LiveMcpApp
      app={app}
      bridge={bridge}
      key={`${app.serverId} ${app.toolName} ${app.resourceUri}`}
      {...(hostVersion === undefined ? {} : { hostVersion })}
      {...(onSessionChange === undefined ? {} : { onSessionChange })}
      {...(ports === undefined ? {} : { ports })}
    />
  );
}
