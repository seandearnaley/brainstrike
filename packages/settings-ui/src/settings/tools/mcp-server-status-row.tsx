import {
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
import { McpServerCatalog } from './mcp-support-status';
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

function McpAuthStatus({ server }: { readonly server: McpServerInfo }) {
  const { auth } = server;
  if (!auth) {
    return null;
  }
  if (auth.type === 'none') {
    return <div className="text-muted-foreground text-xs">Authentication: none</div>;
  }
  if (auth.type === 'bearer') {
    return <div className="text-muted-foreground text-xs">Bearer credential configured</div>;
  }
  const credentialLabel =
    auth.credentialState === 'stored'
      ? 'stored'
      : auth.credentialState === 'unreadable'
        ? 'unreadable'
        : 'not stored';
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

export function McpServerStatusRow({
  controlAvailable,
  onControl,
  server,
}: {
  readonly controlAvailable: boolean;
  readonly onControl: (request: McpHostControlRequest) => Promise<void>;
  readonly server: McpServerInfo;
}) {
  const actions = controlAvailable ? resolveMcpHostControlActions(server) : [];
  const pendingActionRef = useRef<McpHostControlRequest['action'] | null>(null);
  const [pendingAction, setPendingAction] = useState<McpHostControlRequest['action'] | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<CredentialDestructiveAction | null>(
    null
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const runControl = async (action: McpHostControlRequest['action']): Promise<void> => {
    if (pendingActionRef.current !== null) {
      return;
    }
    pendingActionRef.current = action;
    setPendingAction(action);
    setControlError(null);
    try {
      await onControl({ action, configuredServerId: server.configuredServerId });
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'MCP lifecycle control failed');
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };
  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">{server.configuredServerId}</span>
        <span className="text-muted-foreground">{server.state}</span>
        {actions.map((action) => (
          <Button
            aria-busy={pendingAction === action}
            aria-label={`${MCP_CONTROL_LABELS[action]} ${server.configuredServerId}`}
            data-testid={`mcp-${action}-${server.configuredServerId}`}
            disabled={pendingAction !== null}
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
        <span className="text-muted-foreground">
          transport {server.transport} · policy {server.configuredProtocol} · generation{' '}
          {server.generation}
        </span>
      </div>
      <McpAuthStatus server={server} />
      {server.state === 'connected' && (
        <>
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
          {server.catalog && (
            <McpServerCatalog catalog={server.catalog} serverId={server.configuredServerId} />
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
      {server.diagnostics && server.diagnostics.length > 0 && (
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
      )}
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
