/**
 * Settings → Skills: Agent Skills (SKILL.md) management.
 *
 * Master switch + per-skill enable toggles, persisted in the skills
 * preferences store (durable keys — see `deriveSkillPreferenceKey`) and
 * applied server-side per request. The list loads through the
 * capability-gated `window.skills` scan bridge (desktop main scans
 * `.brainstrike/skills` + `.claude/skills` across mounted roots and home) —
 * INCLUDING invalid skills with their exact validation errors and shadowed
 * skills with their winner, so authors see exactly what loaded and why not
 * (fail closed, never silent). A scan failure renders a DISTINCT error state
 * with Retry — never the empty state, which would falsely claim no skills
 * exist. Web has no bridge and shows an honest desktop-only note.
 */

import type {
  SkillScanEntrySummary,
  SkillsScanResultSummary,
} from '@brainstrike/assistant-contract';
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
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  skillsPreferencesSelectors,
  useSkillsPreferencesStore,
} from '../../stores/skills-preferences-store';

interface SkillsBridge {
  scan: () => Promise<SkillsScanResultSummary>;
}

function getSkillsBridge(): SkillsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { skills?: SkillsBridge }).skills;
  return bridge && typeof bridge.scan === 'function' ? bridge : null;
}

const TIER_DIR_LABEL: Record<SkillScanEntrySummary['tier'], string> = {
  'global-brainstrike': '~/.brainstrike/skills',
  'global-claude': '~/.claude/skills',
  'root-brainstrike': '.brainstrike/skills',
  'root-claude': '.claude/skills',
};

function groupLabel(entry: SkillScanEntrySummary): string {
  const scope = entry.sourceRootDisplayName ?? (entry.sourceRootId ? 'Workspace' : 'Home');
  return `${scope} · ${TIER_DIR_LABEL[entry.tier]}`;
}

function SkillRow(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly entry: SkillScanEntrySummary;
  readonly onToggle: (preferenceKey: string, enabled: boolean) => void;
}): React.JSX.Element {
  const { disabled, enabled, entry, onToggle } = props;
  const title = entry.name ?? entry.dirName;
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{title}</p>
          {entry.tier === 'root-claude' || entry.tier === 'global-claude' ? (
            <Badge variant="outline">Claude Code</Badge>
          ) : null}
          {entry.status === 'ok' && entry.userInvocable === false ? (
            <Badge variant="secondary">model-only</Badge>
          ) : null}
        </div>
        {entry.status === 'invalid' ? (
          <div className="space-y-0.5">
            {(entry.errors ?? []).map((error) => (
              <p className="flex items-center gap-1 text-destructive text-sm" key={error}>
                <AlertTriangle className="size-3.5 shrink-0" />
                {error}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{entry.description}</p>
        )}
        {entry.status === 'shadowed' ? (
          <p className="text-muted-foreground text-xs">
            Shadowed by a higher-priority skill of the same name in{' '}
            <code>{entry.shadowedBy?.absPath}</code> — this copy is inactive.
          </p>
        ) : null}
        {(entry.warnings ?? []).map((warning) => (
          <p
            className="flex items-center gap-1 text-amber-600 text-xs dark:text-amber-500"
            key={warning}
          >
            <AlertTriangle className="size-3 shrink-0" />
            {warning}
          </p>
        ))}
        <p className="truncate text-muted-foreground text-xs" title={entry.absPath}>
          {entry.absPath}
        </p>
      </div>
      {entry.status === 'ok' && entry.preferenceKey ? (
        <Switch
          checked={enabled}
          data-testid={`skill-toggle-${entry.preferenceKey}`}
          disabled={disabled}
          id={`skill-toggle-${entry.preferenceKey}`}
          onCheckedChange={(value) => onToggle(entry.preferenceKey as string, value === true)}
        />
      ) : null}
    </div>
  );
}

type ScanState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly result: SkillsScanResultSummary };

export function SkillsSettingsSection(): React.JSX.Element {
  const masterEnabled = useSkillsPreferencesStore(skillsPreferencesSelectors.masterEnabled);
  const disabledSkillKeys = useSkillsPreferencesStore(skillsPreferencesSelectors.disabledSkillKeys);
  const setMasterEnabled = useSkillsPreferencesStore((state) => state.setMasterEnabled);
  const setSkillDisabled = useSkillsPreferencesStore((state) => state.setSkillDisabled);

  const hasBridge = getSkillsBridge() !== null;
  const [scanState, setScanState] = useState<ScanState>(
    hasBridge ? { kind: 'loading' } : { kind: 'ready', result: { entries: [] } }
  );
  const [scanGeneration, setScanGeneration] = useState(0);

  useEffect(() => {
    const bridge = getSkillsBridge();
    if (!bridge) {
      return;
    }
    let cancelled = false;
    setScanState({ kind: 'loading' });
    bridge
      .scan()
      .then((result) => {
        if (!cancelled) {
          setScanState({ kind: 'ready', result });
        }
      })
      .catch((error: unknown) => {
        // A rejected scan is a DISTINCT, retryable error state — never the
        // empty state, which would falsely claim no skills exist.
        if (!cancelled) {
          setScanState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Skills scan failed',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scanGeneration]);

  const retry = useCallback(() => setScanGeneration((generation) => generation + 1), []);

  const groups = useMemo(() => {
    if (scanState.kind !== 'ready') {
      return [];
    }
    const byGroup = new Map<string, SkillScanEntrySummary[]>();
    for (const entry of scanState.result.entries) {
      const label = groupLabel(entry);
      byGroup.set(label, [...(byGroup.get(label) ?? []), entry]);
    }
    return Array.from(byGroup.entries());
  }, [scanState]);

  const onToggle = useCallback(
    (preferenceKey: string, enabled: boolean) => setSkillDisabled(preferenceKey, !enabled),
    [setSkillDisabled]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Skills</CardTitle>
        <CardDescription>
          Skills teach the assistant specialized workflows (following the Agent Skills spec). Add a
          skill as a <code>&lt;name&gt;/SKILL.md</code> folder under{' '}
          <code>.brainstrike/skills/</code> or <code>.claude/skills/</code> in a workspace folder or
          your home directory. The assistant sees each skill&rsquo;s name and description, and loads
          the full instructions on demand; invoke one yourself by typing{' '}
          <code>/skill:&lt;name&gt;</code> in the composer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm" htmlFor="skills-master-toggle">
              Enable Agent Skills
            </Label>
            <p className="text-muted-foreground text-sm">
              On by default. When off, no skills are offered, injected, or listed to the model.
            </p>
          </div>
          <Switch
            checked={masterEnabled}
            data-testid="skills-master-toggle"
            id="skills-master-toggle"
            onCheckedChange={(value) => setMasterEnabled(value === true)}
          />
        </div>

        {hasBridge ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <p className="font-medium text-sm">Installed skills</p>
              <Button
                disabled={scanState.kind === 'loading'}
                onClick={retry}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw className="size-3.5" />
                Refresh
              </Button>
            </div>

            {scanState.kind === 'loading' ? (
              <p className="text-muted-foreground text-sm">Scanning skills…</p>
            ) : null}

            {scanState.kind === 'error' ? (
              <div
                className="flex items-center justify-between gap-4 rounded-md border border-destructive/50 p-3"
                data-testid="skills-scan-error"
              >
                <p className="flex items-center gap-1 text-destructive text-sm">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  Skills scan failed: {scanState.message}
                </p>
                <Button onClick={retry} size="sm" type="button" variant="outline">
                  Retry
                </Button>
              </div>
            ) : null}

            {scanState.kind === 'ready' && groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No skills found. Create one as{' '}
                <code>.brainstrike/skills/&lt;name&gt;/SKILL.md</code> (or{' '}
                <code>.claude/skills/</code>) in a workspace folder or your home directory.
              </p>
            ) : null}

            <fieldset className="space-y-4 border-0 p-0" disabled={!masterEnabled}>
              {groups.map(([label, entries]) => (
                <div className="space-y-2" key={label}>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
                  {entries.map((entry) => (
                    <SkillRow
                      disabled={!masterEnabled}
                      enabled={!(entry.preferenceKey && disabledSkillKeys[entry.preferenceKey])}
                      entry={entry}
                      key={entry.absPath}
                      onToggle={onToggle}
                    />
                  ))}
                </div>
              ))}
            </fieldset>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Skills are discovered and run in the desktop app (<code>.brainstrike/skills/</code> and{' '}
            <code>.claude/skills/</code> across your workspace folders and home directory).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
