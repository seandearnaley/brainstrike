import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import { isMcpOAuthCredentialAccount } from '@brainstrike/agent-host/file-credentials';
import type { McpHostCloseReport, McpHostSnapshot } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { addLogListener, createLogger, redactSensitiveLogValue } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import { createMcpConfigFile } from './config-file.js';
import { McpContentService } from './content-service.js';
import {
  createCredentialMcpOAuthStore,
  type McpOAuthCredentialStorage,
} from './credential-oauth-store.js';
import { readStoredMcpExtensionPreferences } from './extension-preferences.js';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services.js';
import { serveMcpRuntimeToMain } from './mcp-runtime-server.js';
import {
  MCP_STORE_METHODS,
  type McpDiagnosticEvent,
  McpDiagnosticEventSchema,
  McpDiagnosticScopeSchema,
} from './mcp-runtime-wire.js';
import { identityKey, parseRecords } from './oauth-client-provider.js';
import { McpPresentationService } from './presentation-service.js';
import { McpSettingsAuthority, type McpSettingsAuthorityOptions } from './settings-authority.js';
import { stateStoreMcpTaskStorage } from './state-store-task-storage.js';

const logger = createLogger('DesktopNodeMcpHost');

type Request = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/** A scoped MCP tap; Main acknowledges records through its existing logger. */
export function createDesktopMcpDiagnostics(request: Request) {
  // This scope is deliberately outside the tap: reporting delivery failure must
  // remain loud on host stderr without recursively attempting the same delivery.
  const deliveryLogger = createLogger('DesktopMcpDiagnosticDelivery');
  const failures: unknown[] = [];
  let tail = Promise.resolve();
  const failed = (cause: unknown): void => {
    failures.push(cause);
    deliveryLogger.error('MCP diagnostic delivery failed', { error: cause });
  };
  const enqueue = (event: McpDiagnosticEvent): void => {
    tail = tail
      .then(async () => {
        await request(MCP_STORE_METHODS.diagnostics, event);
      })
      .catch(failed);
  };
  const remove = addLogListener((record) => {
    if (!Schema.is(McpDiagnosticScopeSchema)(record.scope)) {
      return;
    }
    try {
      // LogRecord is already redacted by the producer. Keep its typed payload,
      // and bound cyclic/Error values before the JSON-RPC serialization boundary.
      const wireRecord: unknown = JSON.parse(
        JSON.stringify(
          redactSensitiveLogValue(record, [], new WeakMap(), {
            maxDepth: 32,
            repeatedValue: '[REPEATED: MCP diagnostic value]',
          })
        )
      );
      enqueue(
        wireDecoder(McpDiagnosticEventSchema, { errors: 'all', onExcessProperty: 'error' })({
          record: wireRecord,
          type: 'record',
        })
      );
    } catch (cause) {
      failed(cause);
    }
  });
  const drain = async (): Promise<void> => {
    let joined: Promise<void>;
    do {
      joined = tail;
      await joined;
    } while (joined !== tail);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'MCP diagnostic delivery failed');
    }
  };
  return {
    dispose: remove,
    drain,
    async reset(hostCloseReport: McpHostCloseReport, snapshot: McpHostSnapshot): Promise<void> {
      await drain();
      enqueue(
        wireDecoder(McpDiagnosticEventSchema, { errors: 'all', onExcessProperty: 'error' })({
          hostCloseReport,
          snapshot,
          type: 'reset',
        })
      );
      await drain();
    },
    async shutdown(hostCloseReport: McpHostCloseReport): Promise<void> {
      await drain();
      enqueue(
        wireDecoder(McpDiagnosticEventSchema, { errors: 'all', onExcessProperty: 'error' })({
          hostCloseReport,
          type: 'shutdown',
        })
      );
      await drain();
    },
  };
}

/** The desktop composition observes the canonical settings reset after it joins. */
class DesktopMcpSettingsAuthority extends McpSettingsAuthority {
  constructor(
    options: McpSettingsAuthorityOptions,
    private readonly resetCompleted: () => Promise<void>
  ) {
    super(options);
  }
  override async reset(): Promise<void> {
    await super.reset();
    await this.resetCompleted();
  }
}

/** The profile credential store Main and this host share. */
export interface DesktopNodeMcpCredentials {
  /** MCP bearer references, behind the host's credential gate. */
  secrets(): Pick<SecretsService, 'getKey' | 'listProviders'>;
  /** The raw accounts: this host is the one writer of its MCP OAuth records. */
  store(): McpOAuthCredentialStorage;
}

export interface DesktopNodeMcpHostOptions {
  readonly connection: MessageConnection;
  readonly credentials: DesktopNodeMcpCredentials;
  /** Requests to Main over the private platform connection. */
  readonly request: Request;
  readonly startup: Pick<HostStartupContext, 'signal' | 'store'>;
  /** The desktop profile: `mcp/` holds its config and tool preferences. */
  readonly userDataDir: string;
}

export interface DesktopNodeMcpHost {
  close(): Promise<void>;
  /** The desktop windows' MCP content browsing. */
  readonly content: McpContentService;
  /** The desktop windows' MCP Tasks cards and server input. */
  readonly presentation: McpPresentationService;
  readonly services: McpHostServices;
  /** The profile's MCP settings: config file, extension dials and tool preferences. */
  readonly settings: McpSettingsAuthority;
}

/**
 * The desktop Node host owns the one MCP runtime and its settings. Host-thread
 * MCP tools run here, inside Core's process; Main reaches the same runtime for
 * its remaining renderer surfaces. Its config and tool preferences live in the
 * profile's `mcp/` directory, its extension dials and Tasks in the host's
 * StateStore, its OAuth records in the profile credential store under their
 * 64-hex identity accounts. Only the external opener and the native config
 * picker stay behind narrow Main adapters.
 */
export async function createDesktopNodeMcpHost(
  options: DesktopNodeMcpHostOptions
): Promise<DesktopNodeMcpHost> {
  const { connection, credentials, request, startup, userDataDir } = options;
  const taskStorage = stateStoreMcpTaskStorage(startup.store);
  // The stored opt-out applies before any server hears what this client supports.
  const extensions = await readStoredMcpExtensionPreferences(startup.store);
  // Created eagerly, so the host's factory reset reaches its records before any connect.
  const oauthStore = createCredentialMcpOAuthStore({
    accountForIdentity: identityKey,
    credentials: credentials.store(),
    ownsAccount: isMcpOAuthCredentialAccount,
    parseRecords,
  });
  // The runtime's last OAuth writes join before the reset registration goes.
  const closeServices = async (owned: McpHostServices) => {
    try {
      return await owned.close();
    } finally {
      try {
        await oauthStore.join();
      } finally {
        oauthStore.unregister();
      }
    }
  };
  const diagnostics = createDesktopMcpDiagnostics(request);
  let services: McpHostServices;
  try {
    services = await createMcpHostServices({
      appUi: 'rich',
      // Main asks for local presentation explicitly; until then local input fails closed.
      attachElicitationPresenter: () => () => undefined,
      bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
        getKey: (key) => credentials.secrets().getKey(key),
        listProviders: () => credentials.secrets().listProviders(),
      }),
      collectCombinedTools,
      extensionPreferences: extensions.preferences,
      // The settings authority loads the profile's config once it starts.
      mcpConfiguration: { servers: [] },
      oauthStore,
      openExternal: async (url) => {
        await request(MCP_STORE_METHODS.openExternal, { url });
      },
      // The host's StateStore is the one MCP Tasks writer.
      openTaskStorage: async () => taskStorage,
      startup,
    });
  } catch (cause) {
    oauthStore.unregister();
    try {
      await diagnostics.drain();
    } catch (delivery) {
      throw new AggregateError(
        [cause, delivery],
        'Desktop MCP host startup and diagnostics failed'
      );
    } finally {
      diagnostics.dispose();
    }
    throw cause;
  }
  const settings = new DesktopMcpSettingsAuthority(
    {
      configFile: createMcpConfigFile(userDataDir),
      extensionStore: startup.store,
      runtime: services.runtime,
      userDataDir,
    },
    () =>
      diagnostics.reset(services.runtime.retiredCleanupReport(), services.runtime.host.snapshot())
  );
  const presentation = new McpPresentationService(services.runtime);
  const content = new McpContentService({
    admit: () => settings.admitContent(),
    host: services.runtime.host,
  });
  let server: ReturnType<typeof serveMcpRuntimeToMain> | undefined;
  try {
    server = serveMcpRuntimeToMain(connection, settings);
    await request(MCP_STORE_METHODS.ready, {});
  } catch (cause) {
    server?.close();
    presentation.close();
    const failures: unknown[] = [cause];
    for (const cleanup of [
      () => settings.close(),
      () => closeServices(services),
      () => diagnostics.drain(),
    ]) {
      try {
        await cleanup();
      } catch (failure) {
        failures.push(failure);
      }
    }
    diagnostics.dispose();
    throw new AggregateError(failures, 'Desktop MCP host startup and cleanup failed');
  }
  // Config load and discovery reach servers over the network: host readiness never
  // waits for them. Settings requests queue behind this start on its lifecycle.
  void settings.start().catch((error: unknown) => {
    logger.error('MCP settings startup failed', { error });
  });
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        server?.close();
        presentation.close();
        const failures: unknown[] = [];
        try {
          await settings.close();
        } catch (cause) {
          failures.push(cause);
        }
        try {
          const report = await closeServices(services);
          failures.push(...report.failures);
          if (failures.length === 0) {
            await diagnostics.shutdown(report);
          }
        } catch (cause) {
          failures.push(cause);
        }
        try {
          await diagnostics.drain();
        } catch (cause) {
          failures.push(cause);
        } finally {
          diagnostics.dispose();
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Desktop MCP host cleanup failed');
        }
      })()),
    content,
    presentation,
    services,
    settings,
  };
}
