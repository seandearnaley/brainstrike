import {
  MCP_EXTENSION_KEYS,
  MCP_EXTENSION_LABEL_BY_KEY,
  type McpHostControlRequest,
  resolveMcpHostControlActions,
} from '@brainstrike/assistant-contract';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import { useRef, useState } from 'react';
import { McpServerCatalog, type McpServerCatalogContentActions } from './mcp-support-status';
import {
  describeMcpToolsAvailability,
  resolveMcpToolsAvailability,
} from './mcp-tools-availability';
import type { McpServerInfo } from './types';

const MCP_CONTROL_LABELS = {
  cancel: 'Cancel',
  connect: 'Connect',
  disconnect: 'Disconnect',
  reauthorize: 'Reauthorize',
  retry: 'Retry',
} satisfies Record<McpHostControlRequest['action'], string>;

type CredentialDestructiveAction = Extract<
  McpHostControlRequest['action'],
  'disconnect' | 'reauthorize'
>;

function isCredentialDestructiveAction(
  action: McpHostControlRequest['action']
): action is CredentialDestructiveAction {
  return action === 'disconnect' || action === 'reauthorize';
}

function formatConnectionTimestamp(value: number): { dateTime: string; label: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { dateTime: date.toISOString(), label: date.toLocaleString() };
}

function credentialStateLabel(state: 'malformed' | 'missing' | 'stored' | 'unreadable'): string {
  switch (state) {
    case 'malformed':
      return 'malformed';
    case 'missing':
      return 'not stored';
    case 'stored':
      return 'stored';
    case 'unreadable':
      return 'unreadable';
  }
}

function McpCredentialFaultNotice({ server }: { readonly server: McpServerInfo }) {
  const { auth } = server;
  const hasFault =
    auth &&
    auth.type !== 'none' &&
    (auth.credentialState === 'malformed' || auth.credentialState === 'unreadable');
  return (
    <div className="text-destructive text-xs" role="status">
      {hasFault ? (
        <>
          Stored credentials are {credentialStateLabel(auth.credentialState)}. Open connection
          details for more information.
        </>
      ) : null}
    </div>
  );
}

/**
 * "Connected" is a transport fact, not a statement that `tools/list` returned
 * (BST-1603). Without this line the row shows one green state for a server that
 * loaded its tools and for one that silently contributed none to every run.
 */
function McpToolsAvailabilityNotice({ server }: { readonly server: McpServerInfo }) {
  const label = describeMcpToolsAvailability(resolveMcpToolsAvailability(server));
  if (!label) {
    return null;
  }
  return (
    // `text-warning`, the repo's semantic warning token (--bs-warning, deep
    // amber, 4.66:1 against the light muted surface) — NOT a raw palette shade.
    // Measured live in the settings dialog, `text-yellow-500` is 1.87:1 there
    // and WCAG AA wants 4.5:1 for small text. The token also carries its own
    // dark-mode value, so no shade is being guessed.
    <div className="text-warning text-xs">
      connected · {label} — this server enumerated no tools for this run
    </div>
  );
}

function McpAuthStatus({ server }: { readonly server: McpServerInfo }) {
  const { auth } = server;
  if (!auth) {
    return null;
  }
  if (auth.type === 'none') {
    return <div className="text-muted-foreground text-xs">Authentication: none</div>;
  }
  if (auth.type === 'bearer') {
    const credentialLabel = credentialStateLabel(auth.credentialState);
    return <div className="text-muted-foreground text-xs">Bearer credential {credentialLabel}</div>;
  }
  const credentialLabel = credentialStateLabel(auth.credentialState);
  const lastSuccessfulConnection =
    auth.lastSuccessfulConnectionAt === undefined
      ? undefined
      : formatConnectionTimestamp(auth.lastSuccessfulConnectionAt);
  return (
    <div className="mt-1 space-y-0.5 text-muted-foreground text-xs">
      <div>OAuth credentials {credentialLabel}</div>
      <div className="break-all">Protected resource: {auth.resourceUrl}</div>
      <div>
        Requested scopes:{' '}
        {auth.requestedScopes.length > 0 ? auth.requestedScopes.join(', ') : 'server-defined'}
      </div>
      <div>
        Granted scopes: {auth.grantedScopes.length > 0 ? auth.grantedScopes.join(', ') : 'none'}
      </div>
      {auth.authorizationServer && (
        <div className="break-all">Authorization server: {auth.authorizationServer}</div>
      )}
      {lastSuccessfulConnection !== undefined && (
        <div>
          Last successful connection:{' '}
          {lastSuccessfulConnection ? (
            <time dateTime={lastSuccessfulConnection.dateTime}>
              {lastSuccessfulConnection.label}
            </time>
          ) : (
            'invalid stored timestamp'
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The EFFECTIVE registered-extension state for THIS server (BST-1604): the
 * global dial AND the server's own `extensions` override, as decided by the
 * connection generation. Absent on snapshots that predate the field.
 */
function McpExtensionStatus({ server }: { readonly server: McpServerInfo }) {
  const { extensions } = server;
  if (!extensions) {
    return null;
  }
  const extensionAttributes = Object.fromEntries(
    MCP_EXTENSION_KEYS.map((key) => [`data-extension-${key}`, extensions[key] ? 'on' : 'off'])
  );
  return (
    <div
      className="mt-1 text-muted-foreground text-xs"
      data-testid={`mcp-extensions-${server.configuredServerId}`}
      {...extensionAttributes}
    >
      {MCP_EXTENSION_KEYS.map(
        (key) => `${MCP_EXTENSION_LABEL_BY_KEY[key]}: ${extensions[key] ? 'advertised' : 'off'}`
      ).join(' · ')}
    </div>
  );
}

// The host publishes terminal transport faults as error and OAuth consent
// requirements as authentication-required. Connecting/disconnected are lifecycle
// states; their diagnostic history remains available in Connection details.
function hasConnectionFailure(server: McpServerInfo): boolean {
  return server.state === 'error' || server.state === 'authentication-required';
}

function McpDiagnostics({ server }: { readonly server: McpServerInfo }) {
  if (!server.diagnostics?.length) {
    return null;
  }
  return (
    <div
      className="mt-1 whitespace-pre-line text-muted-foreground text-xs"
      data-testid={`mcp-diagnostics-${server.configuredServerId}`}
    >
      {server.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.stream} · ${diagnostic.message}${
              diagnostic.truncated ? ' · truncated' : ''
            }`
        )
        .join('\n')}
    </div>
  );
}

function McpConnectionDetails({ server }: { readonly server: McpServerInfo }) {
  return (
    <details className="mt-2 text-muted-foreground text-xs">
      <summary
        aria-label={`Connection details for ${server.configuredServerId}`}
        className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        Connection details
      </summary>
      <div className="mt-1 space-y-1 break-words">
        <span className="text-muted-foreground">
          transport {server.transport} · policy {server.configuredProtocol} · generation{' '}
          {server.generation}
        </span>
        <McpAuthStatus server={server} />
        <McpExtensionStatus server={server} />
        {server.state === 'connected' && (
          <div className="text-muted-foreground text-xs">
            era {server.negotiated.era} · revision {server.negotiated.revision}
            {server.negotiated.serverIdentity
              ? ` · ${server.negotiated.serverIdentity.name} ${server.negotiated.serverIdentity.version}`
              : ''}
            {` · capabilities: ${
              server.negotiated.advertisedCapabilityIds?.join(', ') ||
              (server.negotiated.advertisedCapabilityIds ? 'none' : 'unavailable')
            }`}
          </div>
        )}
        {!hasConnectionFailure(server) && <McpDiagnostics server={server} />}
      </div>
    </details>
  );
}

export function McpServerStatusRow({
  controlAvailable,
  onComplete,
  onControl,
  onGetPrompt,
  onReadResource,
  server,
}: {
  readonly controlAvailable: boolean;
  readonly onComplete?: McpServerCatalogContentActions['onComplete'];
  readonly onControl: (request: McpHostControlRequest) => Promise<void>;
  readonly onGetPrompt?: McpServerCatalogContentActions['onGetPrompt'];
  readonly onReadResource?: McpServerCatalogContentActions['onReadResource'];
  readonly server: McpServerInfo;
}) {
  const actions = controlAvailable ? resolveMcpHostControlActions(server) : [];
  const pendingActionRef = useRef<{
    readonly action: McpHostControlRequest['action'];
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<McpHostControlRequest['action'] | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<CredentialDestructiveAction | null>(
    null
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const runControl = async (action: McpHostControlRequest['action']): Promise<void> => {
    if (
      pendingActionRef.current !== null &&
      !(action === 'cancel' && pendingActionRef.current.action !== 'cancel')
    ) {
      return;
    }
    const invocation = Object.freeze({ action });
    pendingActionRef.current = invocation;
    setPendingAction(action);
    setControlError(null);
    try {
      await onControl({ action, configuredServerId: server.configuredServerId });
    } catch (cause) {
      if (pendingActionRef.current === invocation) {
        setControlError(cause instanceof Error ? cause.message : 'MCP lifecycle control failed');
      }
    } finally {
      if (pendingActionRef.current === invocation) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    }
  };
  return (
    <div
      className="rounded-md border px-3 py-2 text-sm"
      data-testid={`mcp-server-row-${server.configuredServerId}`}
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">{server.configuredServerId}</span>
        <span className="text-muted-foreground">{server.state}</span>
        {actions.map((action) => (
          <Button
            aria-busy={pendingAction === action}
            aria-label={`${MCP_CONTROL_LABELS[action]} ${server.configuredServerId}`}
            data-testid={`mcp-${action}-${server.configuredServerId}`}
            disabled={
              pendingAction !== null && !(action === 'cancel' && pendingAction !== 'cancel')
            }
            key={action}
            onClick={() => {
              if (isCredentialDestructiveAction(action)) {
                setConfirmationAction(action);
                return;
              }
              void runControl(action);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {MCP_CONTROL_LABELS[action]}
          </Button>
        ))}
      </div>
      <McpCredentialFaultNotice server={server} />
      {server.state === 'connected' && (
        <>
          <McpToolsAvailabilityNotice server={server} />
          {server.catalog && (
            <McpServerCatalog
              catalog={server.catalog}
              generation={server.generation}
              // A replaced server keeps its id but not its generation; remount
              // so content, prompt drafts, and completions from the retired
              // generation never render under (or submit against) the new one.
              key={server.generation}
              onComplete={onComplete}
              onGetPrompt={onGetPrompt}
              onReadResource={onReadResource}
              serverId={server.configuredServerId}
            />
          )}
        </>
      )}
      {server.state === 'error' && (
        <div className="text-destructive text-xs">
          {server.error.category} · {server.error.code} · {server.error.message}
        </div>
      )}
      {controlError && (
        <div className="text-destructive text-xs" role="alert">
          MCP lifecycle control failed: {controlError}
        </div>
      )}
      {hasConnectionFailure(server) && <McpDiagnostics server={server} />}
      <McpConnectionDetails key={server.generation} server={server} />
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setConfirmationAction(null);
          }
        }}
        open={confirmationAction !== null}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmationAction === 'disconnect' ? 'Disconnect OAuth server?' : 'Reauthorize?'}
            </DialogTitle>
            <DialogDescription>
              {confirmationAction === 'disconnect'
                ? `Disconnect ${server.configuredServerId} and remove its stored OAuth credentials?`
                : `Reauthorize ${server.configuredServerId}? Its stored OAuth credentials will be cleared before a new authorization flow opens.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmationAction(null)} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              aria-label={
                confirmationAction
                  ? `Confirm ${confirmationAction} ${server.configuredServerId}`
                  : undefined
              }
              onClick={() => {
                const action = confirmationAction;
                setConfirmationAction(null);
                if (action) {
                  void runControl(action);
                }
              }}
              type="button"
              variant="destructive"
            >
              {confirmationAction === 'disconnect' ? 'Disconnect' : 'Reauthorize'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
