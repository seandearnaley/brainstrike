import type { McpAppBridge, McpAppOrigin } from '@brainstrike/assistant-contract';
import {
  parseMcpAppPrepareRequest,
  readMcpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { ToolFallback } from '@brainstrike/assistant-ui/tool-fallback';
import type { ToolResultRendererProps } from '@brainstrike/assistant-ui/tool-result-renderers';
import { createLogger } from '@brainstrike/logging';
import {
  McpAppFrameBridge,
  type McpAppFrameEventTarget,
  type McpAppFrameSource,
  type McpAppGeneration,
  McpAppProvenanceAuthority,
  McpAppSandboxOwner,
  McpAppToolCallAuthority,
  type McpAppToolRiskCategory,
} from '@brainstrike/mcp-app-host';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { type McpAppHostState, McpAppHostSurface } from './mcp-app-host-surface';
import { useMcpAppBridge } from './use-mcp-app-bridge';
import { useMcpAppsEnabled } from './use-mcp-apps-enablement';

const logger = createLogger('McpAppToolResult');

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const DEFAULT_HOST_VERSION = '1.0.0';
const FRAME_READY_TIMEOUT_MS = 10_000;
const FRAME_POLL_INTERVAL_MS = 20;

const RISK_CATEGORIES: readonly McpAppToolRiskCategory[] = ['edit', 'execute', 'mcp', 'read'];

/**
 * Host-side ports the app runtime needs. Injectable so the renderer can be
 * exercised without a real nested-srcdoc frame; the default reads the live
 * window and the sandbox shell's nested app frame exactly as the packaged
 * lifecycle proof does. Shell URLs are NOT a port: the host bridge serves
 * each shell from its own `brainstrike-mcp-app:` origin (BST-1572), so the
 * renderer never mints a URL of its own.
 */
export interface McpAppRuntimePorts {
  readonly eventTarget: McpAppFrameEventTarget;
  readonly resolveFrameSource: (frame: HTMLIFrameElement) => McpAppFrameSource | undefined;
}

/** Handles for an app session that reached the frame-connected state. */
export interface McpAppMountedSession {
  readonly authority: McpAppToolCallAuthority;
  readonly frameBridge: McpAppFrameBridge;
  readonly sandboxOwner: McpAppSandboxOwner;
}

export interface McpAppToolResultProps extends ToolResultRendererProps {
  readonly hostVersion?: string;
  /** Observation seam: the live session, then `undefined` once teardown settles. */
  readonly onSessionChange?: (session: McpAppMountedSession | undefined) => void;
  readonly ports?: McpAppRuntimePorts;
}

/**
 * The shell is cross-origin to the host, so its document is unreachable;
 * the nested app frame is addressed as the shell window's first child
 * WindowProxy (`window[0]`), which cross-origin access permits.
 */
function resolveNestedAppFrame(frame: HTMLIFrameElement): McpAppFrameSource | undefined {
  const shell = frame.contentWindow;
  if (shell === null || shell.length === 0) {
    return undefined;
  }
  return shell[0];
}

function createDefaultRuntimePorts(): McpAppRuntimePorts {
  return { eventTarget: window, resolveFrameSource: resolveNestedAppFrame };
}

function initializeResult(hostVersion: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    hostCapabilities: Object.freeze({ serverTools: Object.freeze({}) }),
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

interface AppSession {
  readonly authority: McpAppToolCallAuthority;
  readonly generation: McpAppGeneration;
  readonly provenance: McpAppProvenanceAuthority;
  readonly resourceValue: (html: string) => Readonly<Record<string, unknown>>;
  readonly tool: ReturnType<McpAppProvenanceAuthority['registerTool']>;
}

/**
 * ONE state cell: the session, the surface phase, and the shell URL always
 * move together, so no render ever shows a ready surface without its frame
 * (or a surface bound to a session the effect has already retired).
 */
interface McpAppView {
  readonly session: AppSession;
  readonly shellUrl?: string;
  readonly state: McpAppHostState;
}

/**
 * A renderer-local provenance + tool-call authority for ONE effect run. The
 * generation is per-run (a fresh provenance authority, opened at generation
 * 1), and the mount effect creates it: every cleanup retires exactly the
 * generation its own run opened, so a re-run (StrictMode double-invocation,
 * a changed bridge or ports) never replays a retired generation's ownership.
 * `prepare`/`execute`/`release` are the host bridge's admission contract: the
 * renderer never talks to the MCP server itself.
 */
function createAppSession(app: McpAppOrigin, threadId: string, bridge: McpAppBridge): AppSession {
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
          threadId,
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
  threadId,
}: {
  readonly app: McpAppOrigin;
  readonly bridge: McpAppBridge;
  readonly hostVersion?: string;
  readonly onSessionChange?: (session: McpAppMountedSession | undefined) => void;
  readonly ports?: McpAppRuntimePorts;
  readonly threadId: string;
}): ReactElement {
  const runtimePorts = useMemo(() => ports ?? createDefaultRuntimePorts(), [ports]);
  // The persisted marker is re-read (freshly parsed) on every parent render,
  // so the mount identity is the origin's primitives, never the object.
  const { mimeType, resourceUri, serverId, toolName } = app;
  const origin = useMemo<McpAppOrigin>(
    () => ({ mimeType, resourceUri, serverId, toolName }),
    [mimeType, resourceUri, serverId, toolName]
  );
  // `undefined` only between commit and the mount effect's first run.
  const [view, setView] = useState<McpAppView | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const sessionChangeRef = useRef(onSessionChange);
  useEffect(() => {
    sessionChangeRef.current = onSessionChange;
  }, [onSessionChange]);

  useEffect(() => {
    let disposed = false;
    let frameBridge: McpAppFrameBridge | undefined;
    const session = createAppSession(origin, threadId, bridge);
    // Ownership lives in McpAppSandboxOwner: every shell it registers through
    // the bridge is released by its mount's `close()`, which the cleanup
    // drives through `sandboxOwner.closeAll()`.
    const sandboxOwner = new McpAppSandboxOwner({ shellHost: bridge });
    setView({ session, state: { phase: 'loading' } });

    const fail = (code: 'load-failed' | 'protocol-failed'): void =>
      setView({ session, state: { code, phase: 'error' } });

    const start = async (): Promise<void> => {
      const html = await bridge.readResource(origin);
      if (disposed) {
        return;
      }
      const resource = session.provenance.resolveResource(
        session.generation,
        session.tool,
        session.resourceValue(html)
      );
      const mount = await sandboxOwner.open(resource);
      if (disposed) {
        // The cleanup's closeAll ran while registration was in flight; the
        // served shell is ours to release.
        await mount.close();
        return;
      }
      setView({ session, shellUrl: mount.shellUrl, state: { phase: 'ready' } });
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
  }, [bridge, hostVersion, origin, runtimePorts, threadId]);

  if (view === undefined) {
    return <div className="my-1 max-w-xl" ref={recoveryRef} tabIndex={-1} />;
  }
  return (
    <div className="my-1 max-w-xl" ref={recoveryRef} tabIndex={-1}>
      <McpAppHostSurface
        appName={origin.toolName}
        authority={view.session.authority}
        recoveryFocusRef={recoveryRef}
        state={view.state}
      >
        {view.shellUrl === undefined ? null : (
          <iframe
            aria-label={`${origin.toolName} app`}
            className="h-64 w-full rounded-lg border-0"
            data-mcp-app-sandbox="true"
            key={view.shellUrl}
            ref={frameRef}
            src={view.shellUrl}
            title={`${origin.toolName} app`}
          />
        )}
      </McpAppHostSurface>
    </div>
  );
}

/**
 * Renders an MCP App tool result (BST-1572). With no host bridge, or no
 * persisted thread to correlate admission through, the ordinary result is
 * rendered through {@link ToolFallback} plus a visible note — the host's
 * inability to run apps is stated, never silently swallowed.
 */
export function McpAppToolResult({
  hostVersion,
  onSessionChange,
  ports,
  threadId,
  ...toolCall
}: McpAppToolResultProps): ReactElement {
  const bridge = useMcpAppBridge();
  const marker = readMcpAppToolInvocationResult(toolCall.result);
  // Hooks run before the marker guard so the enablement subscription is
  // unconditional; a non-app result still short-circuits below.
  const appsEnabled = useMcpAppsEnabled(marker?.app.serverId ?? '');
  if (marker === undefined) {
    return <ToolFallback {...toolCall} />;
  }
  const app = marker.app;
  if (bridge === null || threadId === undefined || !appsEnabled) {
    return (
      <div className="my-1">
        <ToolFallback {...toolCall} result={marker.result} />
        <p
          className="mt-1 text-muted-foreground text-xs"
          data-testid="mcp-app-host-note"
          role="note"
        >
          {bridge === null
            ? 'App rendering unavailable in this host'
            : threadId === undefined
              ? 'App rendering requires a persisted thread'
              : 'MCP Apps are turned off for this server'}
        </p>
      </div>
    );
  }
  // A different app origin, or a different owning thread, is a different
  // mount: nothing carries over.
  return (
    <LiveMcpApp
      app={app}
      bridge={bridge}
      key={`${threadId} ${app.serverId} ${app.toolName} ${app.resourceUri}`}
      threadId={threadId}
      {...(hostVersion === undefined ? {} : { hostVersion })}
      {...(onSessionChange === undefined ? {} : { onSessionChange })}
      {...(ports === undefined ? {} : { ports })}
    />
  );
}
