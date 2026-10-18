import {
  MCP_CATALOG,
  type McpCatalogAccess,
  type McpCatalogEntry,
  type McpCatalogInstallRequest,
} from '@brainstrike/assistant-contract/mcp-catalog';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { type FormEvent, useCallback, useId, useState } from 'react';
import { openExternalLink } from '../external-link';
import type { ToolsSettingsOperations } from './types';

type InstallCatalogServer = NonNullable<ToolsSettingsOperations['installMcpCatalogServer']>;
type InstallResult = Awaited<ReturnType<InstallCatalogServer>>;
type TokenEntry = Extract<McpCatalogEntry, { auth: 'token' }>;

export interface McpCatalogSectionProps {
  /** Set while the config editor holds unsaved text that an install would leave stale. */
  blockedReason?: string | undefined;
  /** Configured server ids from the Tools settings' MCP host status, the one status owner. */
  configuredServerIds: ReadonlySet<string>;
  installMcpCatalogServer: InstallCatalogServer;
  /** Receives the installed entry's display name. */
  onInstalled: (serverName: string) => Promise<void>;
}

const ACCESS_LABELS: Record<McpCatalogAccess, string> = {
  'read-only': 'Read-only',
  'read-write': 'Read & write',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One-click installs of the curated official remote MCP servers (spec 2026-10-18). */
export function McpCatalogSection({
  blockedReason,
  configuredServerIds,
  installMcpCatalogServer,
  onInstalled,
}: McpCatalogSectionProps) {
  const install = useCallback(
    async (entry: McpCatalogEntry, request: McpCatalogInstallRequest): Promise<InstallResult> => {
      const result = await installMcpCatalogServer(request);
      if (result.success) {
        await onInstalled(entry.name);
      }
      return result;
    },
    [installMcpCatalogServer, onInstalled]
  );

  return (
    <Card data-testid="mcp-catalog">
      <CardHeader>
        <CardTitle>MCP catalog</CardTitle>
        <CardDescription>
          Official remote MCP servers. Installing adds the server to this profile&apos;s MCP config.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {blockedReason ? (
          <p className="text-muted-foreground text-sm" data-testid="mcp-catalog-blocked">
            {blockedReason}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {MCP_CATALOG.map((entry) => (
            <McpCatalogCard
              blocked={blockedReason !== undefined}
              entry={entry}
              installed={configuredServerIds.has(entry.id)}
              key={entry.id}
              onInstall={install}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface McpCatalogCardProps {
  blocked: boolean;
  entry: McpCatalogEntry;
  installed: boolean;
  onInstall: (entry: McpCatalogEntry, request: McpCatalogInstallRequest) => Promise<InstallResult>;
}

function McpCatalogCard({ blocked, entry, installed, onInstall }: McpCatalogCardProps) {
  const [access, setAccess] = useState<McpCatalogAccess>('read-write');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  const submit = async (token?: string): Promise<boolean> => {
    setError(null);
    setPending(true);
    try {
      const result = await onInstall(entry, {
        access,
        catalogId: entry.id,
        ...(token === undefined ? {} : { token }),
      });
      if (!result.success) {
        setError(result.error);
        return false;
      }
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setPending(false);
    }
  };

  const handleInstall = () => {
    if (entry.auth === 'token') {
      setTokenOpen(true);
      return;
    }
    void submit();
  };

  const reportLinkFailure = (failure: string | undefined) => {
    if (failure !== undefined) {
      setError(`Couldn't open link: ${failure}`);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`mcp-catalog-card-${entry.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{entry.name}</span>
        <Badge variant="outline">{entry.auth === 'oauth' ? 'OAuth' : 'Token'}</Badge>
      </div>
      <p className="text-muted-foreground text-xs">{entry.description}</p>
      {entry.urls['read-only'] !== undefined && !installed ? (
        <Tabs
          onValueChange={(value) => setAccess(value === 'read-only' ? 'read-only' : 'read-write')}
          value={access}
        >
          <TabsList aria-label={`${entry.name} access`} size="sm">
            <TabsTrigger value="read-write">{ACCESS_LABELS['read-write']}</TabsTrigger>
            <TabsTrigger value="read-only">{ACCESS_LABELS['read-only']}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <a
          className="text-primary text-xs underline"
          href={entry.docsUrl}
          onClick={(event) => void openExternalLink(event, entry.docsUrl).then(reportLinkFailure)}
          rel="noreferrer"
          target="_blank"
        >
          Docs
        </a>
        {installed ? (
          <Badge data-testid={`mcp-catalog-installed-${entry.id}`} variant="secondary">
            Installed
          </Badge>
        ) : (
          <Button disabled={blocked || pending} onClick={handleInstall} size="sm">
            {pending ? 'Installing…' : 'Install'}
          </Button>
        )}
      </div>
      {error ? (
        <p
          className="text-destructive text-xs"
          data-testid={`mcp-catalog-error-${entry.id}`}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {entry.auth === 'token' ? (
        <McpCatalogTokenDialog
          entry={entry}
          error={error}
          onLinkFailure={reportLinkFailure}
          onOpenChange={setTokenOpen}
          onSubmit={submit}
          open={tokenOpen}
          pending={pending}
        />
      ) : null}
    </div>
  );
}

interface McpCatalogTokenDialogProps {
  entry: TokenEntry;
  error: string | null;
  onLinkFailure: (failure: string | undefined) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (token: string) => Promise<boolean>;
  open: boolean;
  pending: boolean;
}

/** The token leaves component state before the install request is sent. */
function McpCatalogTokenDialog({
  entry,
  error,
  onLinkFailure,
  onOpenChange,
  onSubmit,
  open,
  pending,
}: McpCatalogTokenDialogProps) {
  const [token, setToken] = useState('');
  const inputId = useId();
  const trimmed = token.trim();

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setToken('');
    }
    onOpenChange(next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const captured = trimmed;
    if (captured.length === 0) {
      return;
    }
    setToken('');
    const installed = await onSubmit(captured);
    if (installed) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Install {entry.name}</DialogTitle>
            <DialogDescription>
              BrainStrike stores the token in your system keychain and writes only a reference to it
              in the MCP config.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={inputId}>{entry.token.label}</Label>
            <Input
              autoComplete="off"
              id={inputId}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              value={token}
            />
            <a
              className="text-primary text-xs underline"
              href={entry.token.createUrl}
              onClick={(event) =>
                void openExternalLink(event, entry.token.createUrl).then(onLinkFailure)
              }
              rel="noreferrer"
              target="_blank"
            >
              Create a token
            </a>
            {error ? (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => handleOpenChange(false)} type="button" variant="secondary">
              Cancel
            </Button>
            <Button disabled={pending || trimmed.length === 0} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
