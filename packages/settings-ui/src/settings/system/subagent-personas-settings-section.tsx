/**
 * Settings → Subagents: persona delegation availability.
 *
 * Master switch (delegation on/off) + per-persona toggles, persisted in the
 * subagent-personas store and applied server-side per request. Built-in
 * personas are included in every successful host scan; user-defined personas load from the
 * agent host's scan of `.brainstrike/agents` (`workspace/personas`, desktop
 * only) — INCLUDING invalid persona files with their parse/validation error,
 * so authors see exactly why a file did not load. Web has no host scan and
 * lists the built-ins.
 */

import {
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '@brainstrike/app-state/stores/subagent-personas-store';
import {
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
  personaScope,
} from '@brainstrike/assistant-contract';
import { Badge, Button, Card, cn, ErrorNotice, Label, Switch } from '@brainstrike/ui';
import { AlertTriangle, Layers, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

const BUILT_IN_ITEMS: readonly AssistantPersonaListItem[] = BUILT_IN_PERSONAS.map((persona) => ({
  description: persona.description,
  id: persona.id,
  label: persona.label,
  ...personaScope(persona),
  source: 'built-in',
  status: 'ok',
}));

/**
 * The row's second line: the error for a broken file, the shadowing
 * explanation for a suppressed one, otherwise the description.
 *
 * A shadowed file is styled MUTED, not destructive: it is a precedence
 * outcome (a higher-priority tier owns the id), not an authoring mistake, and
 * a red alert would send the author hunting for a defect that is not there.
 * It still gets a line, because a duplicate that disappears without one is
 * exactly the silence this panel exists to break (BST-936).
 */
function PersonaRowDetail({
  item,
}: {
  readonly item: AssistantPersonaListItem;
}): React.JSX.Element {
  if (item.status === 'invalid') {
    return (
      <p className="text-destructive flex items-center gap-1 text-sm">
        <AlertTriangle className="size-3.5 shrink-0" />
        {item.error}
      </p>
    );
  }
  if (item.status === 'shadowed') {
    // Name the WINNING file: "which copy is live" is the question the author has.
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-sm">
        <Layers className="size-3.5 shrink-0" />
        Shadowed by <code>{item.shadowedBy?.absPath}</code>
      </p>
    );
  }
  const { availability } = item;
  return (
    <>
      <p className="text-muted-foreground text-sm">{item.description}</p>
      {/* An empty checked result deliberately distinguishes no issues from an unchecked row. */}
      {availability ? (
        <div className="mt-1 space-y-1" data-testid={`subagent-persona-availability-${item.id}`}>
          {/* A blocking issue is red; one to check is amber. */}
          {availability.issues.map((issue) => (
            <p
              className={cn(
                'text-sm',
                availability.status === 'blocked' ? 'text-destructive' : 'text-warning'
              )}
              key={`${issue.code}:${issue.toolId ?? ''}`}
            >
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function PersonaRow(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly item: AssistantPersonaListItem;
  readonly onToggle: (personaId: string, enabled: boolean) => void;
}): React.JSX.Element {
  const { disabled, enabled, item, onToggle } = props;
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{item.label}</p>
          {item.source === 'user' ? <Badge variant="outline">User</Badge> : null}
          {item.modelPin ? <Badge variant="secondary">{item.modelPin}</Badge> : null}
        </div>
        <PersonaRowDetail item={item} />
      </div>
      {item.status === 'ok' ? (
        <Switch
          checked={enabled}
          data-testid={`subagent-persona-toggle-${item.id}`}
          disabled={disabled}
          id={`subagent-persona-toggle-${item.id}`}
          onCheckedChange={(value) => onToggle(item.id, value === true)}
        />
      ) : null}
    </div>
  );
}

export interface SubagentPersonasSettingsSectionProps {
  /** The agent host's persona scan with its preflight checks; absent where no host serves it. */
  readonly listPersonas?: () => Promise<AssistantPersonasListResult>;
}

export function SubagentPersonasSettingsSection({
  listPersonas,
}: SubagentPersonasSettingsSectionProps): React.JSX.Element {
  const delegationEnabled = useSubagentPersonasStore(subagentPersonasSelectors.delegationEnabled);
  const disabledPersonaIds = useSubagentPersonasStore(subagentPersonasSelectors.disabledPersonaIds);
  const setDelegationEnabled = useSubagentPersonasStore((state) => state.setDelegationEnabled);
  const setPersonaEnabled = useSubagentPersonasStore((state) => state.setPersonaEnabled);

  const hasHost = listPersonas !== undefined;
  const [load, setLoad] = useState<{
    status: 'loading' | 'loaded' | 'failed';
    result: AssistantPersonasListResult | null;
  }>(() => ({ result: null, status: hasHost ? 'loading' : 'loaded' }));
  const [reloadVersion, setReloadVersion] = useState(0);
  const loading = load.status === 'loading';
  const loadFailed = load.status === 'failed';
  const reloadPersonas = () => {
    setLoad((current) => ({ ...current, status: 'loading' }));
    setReloadVersion((version) => version + 1);
  };
  const incompleteDirs = load.result?.incompleteDirs ?? [];

  useEffect(() => {
    if (!listPersonas) {
      return;
    }
    let cancelled = false;
    listPersonas()
      .then((result) => {
        if (!cancelled) {
          setLoad({ result, status: 'loaded' });
        }
      })
      .catch(() => {
        // Keep the last list visible, but never portray a failed refresh as a
        // successful scan or expose private filesystem/credential error text.
        if (!cancelled) {
          setLoad((current) => ({ ...current, status: 'failed' }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listPersonas, reloadVersion]);

  // Host results include built-ins first; without a host fall back to the
  // static built-in list so the panel is meaningful on web too.
  const items = load.result?.personas ?? (hasHost ? [] : BUILT_IN_ITEMS);
  const disabledSet = new Set(disabledPersonaIds);

  return (
    <Card className="space-y-4 p-4" data-testid="subagent-personas-section">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" className="text-muted-foreground h-4 w-4" />
          <h3 className="text-sm font-medium">Personas</h3>
        </div>
        {hasHost && !loadFailed ? (
          <Button
            aria-label="Refresh personas"
            disabled={loading}
            onClick={reloadPersonas}
            size="sm"
            type="button"
            variant="outline"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        ) : null}
      </div>
      {loadFailed ? (
        <ErrorNotice
          message="The personas didn’t load."
          onRetry={reloadPersonas}
          retryLabel="Retry"
        />
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-medium" htmlFor="subagent-delegation-toggle">
          Enable subagent delegation
        </Label>
        <Switch
          checked={delegationEnabled}
          data-testid="subagent-delegation-toggle"
          id="subagent-delegation-toggle"
          onCheckedChange={(value) => setDelegationEnabled(value === true)}
        />
      </div>

      {incompleteDirs.length > 0 ? (
        <div className="space-y-1" data-testid="subagent-personas-incomplete">
          {incompleteDirs.map((entry) => (
            <p
              className="text-warning flex items-center gap-1 text-sm"
              key={`${entry.reason}:${entry.dir}`}
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              {entry.reason === 'cap-reached'
                ? `Persona scan limit reached before ${entry.dir} was read — personas there were not loaded.`
                : `Too many files to scan in ${entry.dir} — some personas were not read.`}
            </p>
          ))}
        </div>
      ) : null}

      <fieldset className="space-y-3 border-0 p-0" disabled={!delegationEnabled}>
        <legend className="sr-only">Personas</legend>
        {items.map((item) => (
          <PersonaRow
            disabled={!delegationEnabled}
            enabled={!disabledSet.has(item.id)}
            item={item}
            key={item.absPath ?? `${item.source}-${item.id}`}
            onToggle={setPersonaEnabled}
          />
        ))}
      </fieldset>
    </Card>
  );
}
