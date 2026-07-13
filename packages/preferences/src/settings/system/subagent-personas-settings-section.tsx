/**
 * Settings → Subagents: persona delegation availability.
 *
 * Master switch (delegation on/off) + per-persona toggles, persisted in the
 * subagent-personas store and applied server-side per request. Built-in
 * personas always render; user-defined personas load through the
 * capability-gated `window.assistantPersonas` bridge (desktop main scans
 * `.brainstrike/agents`) — INCLUDING invalid persona files with their
 * parse/validation error, so authors see exactly why a file did not load.
 * Web has no bridge and shows an honest desktop-only note instead.
 */

import {
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
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
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '../../stores/subagent-personas-store';

interface PersonasBridge {
  list: () => Promise<AssistantPersonasListResult>;
}

function getPersonasBridge(): PersonasBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { assistantPersonas?: PersonasBridge }).assistantPersonas;
  return bridge ?? null;
}

const BUILT_IN_ITEMS: readonly AssistantPersonaListItem[] = BUILT_IN_PERSONAS.map((persona) => ({
  description: persona.description,
  id: persona.id,
  label: persona.label,
  source: 'built-in',
  status: 'ok',
}));

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
          <p className="font-medium text-sm">{item.label}</p>
          {item.source === 'user' ? <Badge variant="outline">User</Badge> : null}
          {item.modelPin ? <Badge variant="secondary">{item.modelPin}</Badge> : null}
        </div>
        {item.status === 'invalid' ? (
          <p className="flex items-center gap-1 text-destructive text-sm">
            <AlertTriangle className="size-3.5 shrink-0" />
            {item.error}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{item.description}</p>
        )}
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

export function SubagentPersonasSettingsSection(): React.JSX.Element {
  const delegationEnabled = useSubagentPersonasStore(subagentPersonasSelectors.delegationEnabled);
  const disabledPersonaIds = useSubagentPersonasStore(subagentPersonasSelectors.disabledPersonaIds);
  const setDelegationEnabled = useSubagentPersonasStore((state) => state.setDelegationEnabled);
  const setPersonaEnabled = useSubagentPersonasStore((state) => state.setPersonaEnabled);

  const [bridgeItems, setBridgeItems] = useState<readonly AssistantPersonaListItem[] | null>(null);
  const hasBridge = getPersonasBridge() !== null;

  useEffect(() => {
    const bridge = getPersonasBridge();
    if (!bridge) {
      return;
    }
    let cancelled = false;
    bridge
      .list()
      .then((result) => {
        if (!cancelled) {
          setBridgeItems(result.personas);
        }
      })
      .catch(() => {
        // The IPC list is presentational; a failure leaves the built-ins
        // rendered (the store toggles still work) — nothing silent about the
        // personas themselves, which the server resolves independently.
        if (!cancelled) {
          setBridgeItems(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bridge results include built-ins first; without a bridge fall back to the
  // static built-in list so the panel is meaningful on web too.
  const items = bridgeItems ?? BUILT_IN_ITEMS;
  const disabledSet = new Set(disabledPersonaIds);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subagents</CardTitle>
        <CardDescription>
          The assistant can delegate focused, read-only tasks to subagent personas. Add your own
          personas as markdown files in <code>.brainstrike/agents/</code> (workspace or home
          directory).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm" htmlFor="subagent-delegation-toggle">
              Enable subagent delegation
            </Label>
            <p className="text-muted-foreground text-sm">
              On by default. When off, the assistant never delegates to subagents.
            </p>
          </div>
          <Switch
            checked={delegationEnabled}
            data-testid="subagent-delegation-toggle"
            id="subagent-delegation-toggle"
            onCheckedChange={(value) => setDelegationEnabled(value === true)}
          />
        </div>

        <fieldset className="space-y-3 border-0 p-0" disabled={!delegationEnabled}>
          <legend className="font-medium text-sm">Personas</legend>
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

        {hasBridge ? null : (
          <p className="text-muted-foreground text-xs">
            User-defined personas load from <code>.brainstrike/agents/</code> in the desktop app.
            Delegation runs in the desktop assistant runtime.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
