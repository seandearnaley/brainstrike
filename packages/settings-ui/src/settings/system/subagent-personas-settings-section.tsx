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
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '@brainstrike/app-state/stores/subagent-personas-store';
import { type AssistantPersonaListItem, BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract';
import { resolveAssistantPersonasBridge } from '@brainstrike/assistant-contract/personas-bridge';
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
import { AlertTriangle, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';

const BUILT_IN_ITEMS: readonly AssistantPersonaListItem[] = BUILT_IN_PERSONAS.map((persona) => ({
  description: persona.description,
  id: persona.id,
  label: persona.label,
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
      <p className="flex items-center gap-1 text-destructive text-sm">
        <AlertTriangle className="size-3.5 shrink-0" />
        {item.error}
      </p>
    );
  }
  if (item.status === 'shadowed') {
    // Same wording shape as the skills panel: name the WINNING file, because
    // "which copy is live" is the question the author actually has.
    return (
      <p className="flex items-center gap-1 text-muted-foreground text-sm">
        <Layers className="size-3.5 shrink-0" />
        Shadowed by a higher-priority persona of the same name in{' '}
        <code>{item.shadowedBy?.absPath}</code> — this copy is inactive.
      </p>
    );
  }
  return <p className="text-muted-foreground text-sm">{item.description}</p>;
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
          <p className="font-medium text-sm">{item.label}</p>
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

export function SubagentPersonasSettingsSection(): React.JSX.Element {
  const delegationEnabled = useSubagentPersonasStore(subagentPersonasSelectors.delegationEnabled);
  const disabledPersonaIds = useSubagentPersonasStore(subagentPersonasSelectors.disabledPersonaIds);
  const setDelegationEnabled = useSubagentPersonasStore((state) => state.setDelegationEnabled);
  const setPersonaEnabled = useSubagentPersonasStore((state) => state.setPersonaEnabled);

  const [bridgeItems, setBridgeItems] = useState<readonly AssistantPersonaListItem[] | null>(null);
  const [incompleteDirs, setIncompleteDirs] = useState<
    readonly { dir: string; reason: 'cap-reached' | 'listing-truncated' }[]
  >([]);
  const hasBridge = resolveAssistantPersonasBridge() !== null;

  useEffect(() => {
    const bridge = resolveAssistantPersonasBridge();
    if (!bridge) {
      return;
    }
    let cancelled = false;
    bridge
      .list()
      .then((result) => {
        if (!cancelled) {
          setBridgeItems(result.personas);
          setIncompleteDirs(result.incompleteDirs ?? []);
        }
      })
      .catch(() => {
        // The IPC list is presentational; a failure leaves the built-ins
        // rendered (the store toggles still work) — nothing silent about the
        // personas themselves, which the server resolves independently.
        if (!cancelled) {
          setBridgeItems(null);
          setIncompleteDirs([]);
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

        {incompleteDirs.length > 0 ? (
          <div className="space-y-1" data-testid="subagent-personas-incomplete">
            {incompleteDirs.map((entry) => (
              <p
                className="flex items-center gap-1 text-sm text-warning"
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
