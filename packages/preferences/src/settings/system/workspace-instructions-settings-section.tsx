/**
 * Workspace instructions settings panel (auto-injection of a mounted root's
 * `AGENTS.md`/`AGENT.md`/`CLAUDE.md` into the assistant's system context — see
 * AGENTS.md "WORKSPACE INSTRUCTIONS CONTEXT").
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

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { useEffect, useState } from 'react';
import { useWorkspaceInstructionsPreferencesStore } from '../../stores/workspace-instructions-preferences-store';

interface WorkspaceContextFileStatus {
  readonly approxTokens: number | null;
  readonly displayName: string;
  readonly error?: string;
  readonly fileName: string | null;
  readonly oversized: boolean;
  readonly path: string | null;
  readonly rootId: string;
  readonly sizeBytes: number | null;
  readonly status: 'none' | 'fits' | 'oversized' | 'error';
}

interface ContextFilesBridge {
  readonly scan: () => Promise<WorkspaceContextFileStatus[]>;
}

function getContextFilesBridge(): ContextFilesBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { contextFiles?: ContextFilesBridge }).contextFiles;
  return bridge ?? null;
}

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

  // Fetch the per-root scan from the desktop bridge. Canonical data-fetch-in-
  // effect: an `ignore` flag drops a stale response if the panel unmounts before
  // the scan resolves.
  useEffect(() => {
    const bridge = getContextFilesBridge();
    if (!bridge) {
      return;
    }
    let ignore = false;
    bridge
      .scan()
      .then((result) => {
        if (!ignore) {
          setStatuses(result);
        }
      })
      .catch(() => {
        // A bridge failure leaves the prior scan in place; the rows simply do
        // not update. The empty state covers the never-loaded case.
      });
    return () => {
      ignore = true;
    };
  }, []);

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
          <legend className="font-medium text-sm">Detected files</legend>
          {statuses.length === 0 ? (
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
