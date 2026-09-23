/**
 * Settings → Subagents: persona delegation availability.
 *
 * Master switch (delegation on/off) + per-persona toggles, persisted in the
 * subagent-personas store and applied server-side per request. Built-in
 * personas are included in every successful host scan; user-defined personas load through the
 * capability-gated `window.assistantPersonas` bridge (desktop main scans
 * `.brainstrike/agents`) — INCLUDING invalid persona files with their
 * parse/validation error, so authors see exactly why a file did not load.
 * Web has no bridge and shows an honest desktop-only note instead.
 */

import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import {
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '@brainstrike/app-state/stores/subagent-personas-store';
import {
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
  effectiveChildStepBudget,
  personaScope,
} from '@brainstrike/assistant-contract';
import { resolveAssistantPersonasBridge } from '@brainstrike/assistant-contract/personas-bridge';
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
import { AlertTriangle, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';

const BUILT_IN_ITEMS: readonly AssistantPersonaListItem[] = BUILT_IN_PERSONAS.map((persona) => ({
  description: persona.description,
  id: persona.id,
  label: persona.label,
  ...personaScope(persona),
  source: 'built-in',
  status: 'ok',
}));

// The locale is pinned on purpose so limits use consistent grouping on every host.
const LIMIT_NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const TOOL_ID_PREFIX = 'brainstrike.';
const MAX_LISTED_TOOLS = 6;

/** A tool id as the user sees it in the tools settings: without the host prefix. */
function displayToolId(toolId: string): string {
  return toolId.startsWith(TOOL_ID_PREFIX) ? toolId.slice(TOOL_ID_PREFIX.length) : toolId;
}

/**
 * The scope a loadable persona runs with, in plain terms, from the same facts
 * the host enforces: effective mode, the HOST-CAPPED step budget
 * (`effectiveChildStepBudget`, the number the model is told), and the declared
 * capability set. Absent facts (an older bridge) render nothing rather than a
 * guess.
 */
function PersonaScopeLine({ item }: { readonly item: AssistantPersonaListItem }) {
  const settings = useAssistantSubagentPreferencesStore((state) => state.settings);
  if (item.mode === undefined || item.maxSteps === undefined || item.allowedToolIds === undefined) {
    return null;
  }
  const steps = effectiveChildStepBudget({ maxSteps: item.maxSteps }, settings);
  const allTools = item.allowedToolIds.includes('*');
  const listed = item.allowedToolIds.slice(0, MAX_LISTED_TOOLS).map(displayToolId).join(', ');
  const remaining = item.allowedToolIds.length - MAX_LISTED_TOOLS;
  // Worker mode only PERMITS edit/run tools to be declared; the declared list
  // (then host permissions) decides what the child can actually do, so the
  // label names the mode and the tool clause states the scope. A one-step
  // child has no reserved summary turn (`buildChildIterationPolicy`).
  return (
    <p className="text-muted-foreground text-xs" data-testid={`subagent-persona-scope-${item.id}`}>
      Declared scope: {item.mode === 'worker' ? 'Worker mode' : 'Read-only'} · Up to {steps}{' '}
      {steps === 1 ? 'step' : 'steps'}
      {steps >= 2 ? ' (1 reserved for its summary)' : ''} ·{' '}
      {allTools
        ? item.mode === 'worker'
          ? 'every tool the host permits, including edit and run tools'
          : 'every read-only tool the host permits'
        : `${item.allowedToolIds.length} ${item.allowedToolIds.length === 1 ? 'tool' : 'tools'}: ${listed}${remaining > 0 ? ` and ${remaining} more` : ''}`}
    </p>
  );
}

/**
 * The limits the host enforces on every root turn, stated from the user's
 * settings — the same object every request carries — so the panel can never
 * drift from enforcement (a test with non-default settings pins this).
 */
function DelegationLimits() {
  const settings = useAssistantSubagentPreferencesStore((state) => state.settings);
  return (
    <div className="space-y-1" data-testid="subagent-delegation-limits">
      <p className="font-medium text-sm">Limits on every turn</p>
      <p className="text-muted-foreground text-sm">
        Subagents can delegate to other subagents up to {settings.maxDepth} levels deep, with at
        most {settings.maxInvocations} delegations per turn and {settings.maxConcurrentWork}{' '}
        subagents working at once. No subagent may exceed {settings.maxChildSteps} steps, whatever
        its persona declares (see Subagent limits below). Each subagent may produce up to{' '}
        {LIMIT_NUMBER_FORMAT.format(settings.maxChildOutputTokens)} output tokens;{' '}
        {LIMIT_NUMBER_FORMAT.format(settings.maxTreeOutputTokens)} output tokens is the ceiling for
        all subagents in one turn. Personas cannot raise these limits; the host enforces them.
      </p>
    </div>
  );
}

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
  return (
    <>
      <p className="text-muted-foreground text-sm">{item.description}</p>
      <PersonaScopeLine item={item} />
      {/* An empty checked result deliberately distinguishes no issues from an unchecked row. */}
      {item.availability ? (
        <div className="mt-1 space-y-1" data-testid={`subagent-persona-availability-${item.id}`}>
          {item.availability.status === 'request-dependent' ? null : (
            <p className="font-medium text-sm">
              {item.availability.status === 'blocked'
                ? 'Unavailable until corrected'
                : 'Check this configuration'}
            </p>
          )}
          {item.availability.issues.map((issue) => (
            <p className="text-sm text-warning" key={`${issue.code}:${issue.toolId ?? ''}`}>
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

  const hasBridge = resolveAssistantPersonasBridge() !== null;
  const [load, setLoad] = useState<{
    status: 'loading' | 'loaded' | 'failed';
    result: AssistantPersonasListResult | null;
  }>(() => ({ result: null, status: hasBridge ? 'loading' : 'loaded' }));
  const [reloadVersion, setReloadVersion] = useState(0);
  const loading = load.status === 'loading';
  const loadFailed = load.status === 'failed';
  const incompleteDirs = load.result?.incompleteDirs ?? [];

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
  }, [reloadVersion]);

  // Bridge results include built-ins first; without a bridge fall back to the
  // static built-in list so the panel is meaningful on web too.
  const items = load.result?.personas ?? (hasBridge ? [] : BUILT_IN_ITEMS);
  const disabledSet = new Set(disabledPersonaIds);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subagents</CardTitle>
        <CardDescription>
          The assistant can delegate focused tasks to subagent personas: read-only ones survey and
          analyse, and worker personas can edit and run within the tools and permissions the host
          allows. Add your own personas as markdown files in <code>.brainstrike/agents/</code>{' '}
          (workspace or home directory).
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

        <DelegationLimits />
        <p className="text-muted-foreground text-sm">
          Each profile states its declared scope. Available tools, model access and permissions are
          checked again for every request. Host checks below do not grant access or promise that
          every declared tool can run.
        </p>
        {hasBridge ? (
          <div className="space-y-2">
            {loadFailed ? (
              <p className="text-destructive text-sm" role="alert">
                Could not load user personas or check host availability. Retry after checking your
                workspace and provider settings.
              </p>
            ) : null}
            <Button
              disabled={loading}
              onClick={() => {
                setLoad((current) => ({ ...current, status: 'loading' }));
                setReloadVersion((version) => version + 1);
              }}
              size="sm"
              variant="outline"
            >
              {loading
                ? 'Checking personas…'
                : loadFailed
                  ? 'Retry loading personas'
                  : 'Refresh personas and host checks'}
            </Button>
          </div>
        ) : null}

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
