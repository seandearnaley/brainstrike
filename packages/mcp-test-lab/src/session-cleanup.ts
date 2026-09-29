import type { McpLabFaultRuntime } from './fault-runtime.js';
import type { McpOAuthReferenceStateCounts } from './oauth-reference.js';

export interface McpLabCleanupReport {
  readonly httpListenersClosed: number;
  readonly oauthRecordsRemaining?: McpOAuthReferenceStateCounts;
  readonly stdioTransportsClosed: number;
  readonly untriggeredFaultIds: readonly string[];
}

export interface McpLabCleanupResource {
  close(): Promise<void>;
  closed: boolean;
  readonly counted?: () => boolean;
  readonly kind: 'handler' | 'http-listener' | 'stdio-transport';
}

export interface McpLabSessionCleanup {
  close(): Promise<McpLabCleanupReport>;
  readonly closed: boolean;
}

interface McpLabSessionCleanupOptions {
  readonly faultRuntime: McpLabFaultRuntime | undefined;
  readonly oauthStateCounts: (() => McpOAuthReferenceStateCounts) | undefined;
  readonly resources: readonly McpLabCleanupResource[];
}

class McpLabResourceCleanupError extends Error {
  readonly failedResourceKinds: readonly McpLabCleanupResource['kind'][];

  constructor(failedResourceKinds: readonly McpLabCleanupResource['kind'][]) {
    const safeKinds = Object.freeze([...failedResourceKinds].sort());
    super(`MCP lab cleanup failed for ${safeKinds.length} resource(s): ${safeKinds.join(', ')}`);
    this.failedResourceKinds = safeKinds;
    this.name = 'McpLabResourceCleanupError';
  }
}

function createCleanupReport(options: McpLabSessionCleanupOptions): McpLabCleanupReport {
  return Object.freeze({
    httpListenersClosed: options.resources.filter(
      (resource) => resource.kind === 'http-listener' && resource.closed
    ).length,
    ...(options.oauthStateCounts
      ? { oauthRecordsRemaining: Object.freeze({ ...options.oauthStateCounts() }) }
      : {}),
    stdioTransportsClosed: options.resources.filter(
      (resource) =>
        resource.kind === 'stdio-transport' && resource.closed && (resource.counted?.() ?? true)
    ).length,
    untriggeredFaultIds: options.faultRuntime?.untriggeredIds() ?? Object.freeze([]),
  });
}

async function applyCleanupFault(runtime: McpLabFaultRuntime | undefined): Promise<void> {
  if (!runtime) {
    return;
  }
  const correlationId = runtime.reserveCorrelation(undefined, 'shutdown');
  const applied = runtime.consume('shutdown', 'transport/close', correlationId);
  if (!applied) {
    return;
  }
  switch (applied.fault.kind) {
    case 'cleanup_error':
      throw new Error(`MCP lab fault "${applied.id}" injected a cleanup failure`);
    case 'delay': {
      const { delayMs } = applied.fault;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    case 'child_exit':
    case 'child_stderr':
    case 'drop_response':
    case 'http_status':
    case 'malformed_json':
      throw new Error(`MCP lab fault "${applied.id}" is invalid during cleanup`);
    default: {
      const unsupported: never = applied.fault;
      throw new Error(`Unsupported MCP lab cleanup fault: ${String(unsupported)}`);
    }
  }
}

export function createMcpLabSessionCleanup(
  options: McpLabSessionCleanupOptions
): McpLabSessionCleanup {
  let attempt: Promise<McpLabCleanupReport> | undefined;
  let finalReport: McpLabCleanupReport | undefined;
  const cleanup: McpLabSessionCleanup = {
    close(): Promise<McpLabCleanupReport> {
      if (finalReport) {
        return Promise.resolve(finalReport);
      }
      if (attempt) {
        return attempt;
      }
      const currentAttempt = (async () => {
        await applyCleanupFault(options.faultRuntime);
        const failedResourceKinds: McpLabCleanupResource['kind'][] = [];
        for (const resource of options.resources) {
          if (resource.closed) {
            continue;
          }
          try {
            await resource.close();
            resource.closed = true;
          } catch {
            // Resource errors can retain injected payloads, credentials, env, or argv.
            // Cleanup ownership deliberately retains only the safe resource kind.
            failedResourceKinds.push(resource.kind);
          }
        }
        if (failedResourceKinds.length > 0) {
          throw new McpLabResourceCleanupError(failedResourceKinds);
        }
        finalReport = createCleanupReport(options);
        return finalReport;
      })();
      attempt = currentAttempt;
      void currentAttempt.catch(() => {
        if (attempt === currentAttempt) {
          attempt = undefined;
        }
      });
      return currentAttempt;
    },
    get closed() {
      return finalReport !== undefined;
    },
  };
  return Object.freeze(cleanup);
}
