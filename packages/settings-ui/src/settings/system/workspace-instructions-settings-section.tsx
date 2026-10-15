/**
 * Workspace instructions settings panel (auto-injection of a mounted root's
 * `AGENTS.md`/`AGENT.md`/`CLAUDE.md` into the assistant's system context — see
 * docs/agents/workspace-context.md § "Instructions, prompts and skills").
 *
 * CONSUMES `workspace-instructions-preferences-store.ts` (master toggle +
 * per-root oversized opt-in) and the desktop `window.contextFiles` bridge (a
 * per-root scan of the detected file's size + token estimate + injection
 * status). The bridge is desktop-only; on web the panel shows an empty state.
 *
 * Threshold-hybrid policy surfaced here: a `fits` file is auto-injected; an
 * `oversized` file is "detected but not injected (too large)" until the user
 * flips its per-root opt-in, which injects it truncated.
 */

import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import {
  resolveContextFilesBridge,
  type WorkspaceContextFileStatus,
} from '@brainstrike/assistant-contract/context-files-bridge';
import { createLogger } from '@brainstrike/logging';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

const logger = createLogger('WorkspaceInstructionsSettings');

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) {
    return '—';
  }
  if (tokens < 1000) {
    return `~${tokens} tokens`;
  }
  return `~${(tokens / 1000).toFixed(1)}K tokens`;
}

const STATUS_META: Record<
  WorkspaceContextFileStatus['status'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  error: { label: 'Unavailable', variant: 'outline' },
  fits: { label: 'Injected', variant: 'default' },
  none: { label: 'No file', variant: 'outline' },
  oversized: { label: 'Too large', variant: 'secondary' },
};

export function WorkspaceInstructionsSettingsSection() {
  const masterEnabled = useWorkspaceInstructionsPreferencesStore((state) => state.masterEnabled);
  const oversizedOptInByRootId = useWorkspaceInstructionsPreferencesStore(
    (state) => state.oversizedOptInByRootId
  );
  const setMasterEnabled = useWorkspaceInstructionsPreferencesStore(
    (state) => state.setMasterEnabled
  );
  const setOversizedOptIn = useWorkspaceInstructionsPreferencesStore(
    (state) => state.setOversizedOptIn
  );
  const [statuses, setStatuses] = useState<WorkspaceContextFileStatus[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch the per-root scan from the desktop bridge. A scan rejection (DB
  // unavailable, IPC failure, handler bug) is surfaced as a distinct, logged
  // error state — NEVER swallowed into the empty state, which would falsely
  // claim no workspace folders are open. The applier arrows keep setState out of
  // the effect body (react-compiler-friendly data-fetch-in-effect).
  const runScan = useCallback(() => {
    const bridge = resolveContextFilesBridge();
    if (!bridge) {
      return;
    }
    bridge
      .scan()
      .then((result) => {
        if (mountedRef.current) {
          setStatuses(result);
          setScanError(null);
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) {
          return;
        }
        const detail = error instanceof Error ? error.message : 'unknown error';
        logger.error('Workspace context-file scan failed', { error: detail });
        setScanError(detail);
      });
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace instructions</CardTitle>
        <CardDescription>
          Automatically add each open workspace folder’s <code>AGENTS.md</code>,{' '}
          <code>AGENT.md</code>, or <code>CLAUDE.md</code> to the assistant’s context every turn. A
          file that fits the budget is injected whole; a file that is too large is only injected
          (truncated) if you opt that workspace in below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm" htmlFor="context-files-master-toggle">
              Inject workspace instructions
            </Label>
            <p className="text-muted-foreground text-sm">
              On by default. Skipped for the built-in local model (its context is too small).
            </p>
          </div>
          <Switch
            checked={masterEnabled}
            data-testid="context-files-master-toggle"
            id="context-files-master-toggle"
            onCheckedChange={(value) => setMasterEnabled(value === true)}
          />
        </div>

        <fieldset className="space-y-3 border-0 p-0" disabled={!masterEnabled}>
          <div className="flex items-center justify-between gap-4">
            <legend className="font-medium text-sm">Detected files</legend>
            {/* The scan runs on mount; mounting/unmounting a workspace root while
                this panel stays open leaves the list stale, so offer a manual
                rescan (bridge is desktop-only — omitted on web). */}
            {resolveContextFilesBridge() ? (
              <Button
                data-testid="context-files-rescan"
                disabled={!masterEnabled}
                onClick={() => runScan()}
                size="sm"
                variant="outline"
              >
                Rescan
              </Button>
            ) : null}
          </div>
          {scanError ? (
            <div
              className="space-y-2 rounded-md border border-destructive/50 p-3"
              data-testid="context-files-scan-error"
            >
              <p className="text-destructive text-sm">
                Could not scan workspace folders: {scanError}
              </p>
              <Button
                data-testid="context-files-scan-retry"
                onClick={() => runScan()}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          ) : statuses.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="context-files-no-roots">
              No workspace folders with an instructions file are open.
            </p>
          ) : (
            <ul className="space-y-3">
              {statuses.map((entry) => {
                const meta = STATUS_META[entry.status];
                const optedIn = oversizedOptInByRootId[entry.rootId] === true;
                return (
                  <li
                    className="flex items-center justify-between gap-4 rounded-md border p-3"
                    data-testid={`context-files-root-${entry.rootId}`}
                    key={entry.rootId}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{entry.displayName}</p>
                      <p className="truncate text-muted-foreground text-xs">
                        {entry.fileName
                          ? `${entry.fileName} · ${formatBytes(entry.sizeBytes)} · ${formatTokens(entry.approxTokens)}`
                          : 'No AGENTS.md / AGENT.md / CLAUDE.md'}
                      </p>
                      {entry.status === 'oversized' && !optedIn ? (
                        <p className="text-muted-foreground text-xs">
                          Detected but not injected (too large). Opt in to inject it truncated.
                        </p>
                      ) : null}
                      {entry.error ? (
                        <p className="text-destructive text-xs">{entry.error}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {entry.status === 'oversized' ? (
                        <Switch
                          aria-label={`Inject oversized instructions for ${entry.displayName}`}
                          checked={optedIn}
                          data-testid={`context-files-optin-${entry.rootId}`}
                          disabled={!masterEnabled}
                          onCheckedChange={(value) =>
                            setOversizedOptIn(entry.rootId, value === true)
                          }
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      </CardContent>
    </Card>
  );
}
