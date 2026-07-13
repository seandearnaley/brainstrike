/**
 * Permissions settings section (permission engine, step 4b / PR-1.4b).
 *
 * A real product surface for configuring the permission engine that lives in
 * `permission-policy-store.ts`. It CONSUMES the store only — no engine/store
 * logic lives here:
 * - the master `enforce` toggle (ON by default; users can opt out),
 * - a per-`ToolRiskCategory` policy control (allow | ask | deny),
 * - the master `yolo` "allow everything this session" toggle.
 *
 * Honest-surface caveats (no over-claiming): enforcement currently applies to
 * the desktop assistant runtime, where an `'ask'` policy now PROMPTS for per-call
 * approval (approve runs the tool, decline skips it). Those caveats are stated
 * inline rather than implied away.
 */

import {
  PERMISSION_DECISIONS,
  type PermissionDecision,
  TOOL_RISK_CATEGORIES,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Label,
  Switch,
} from '@brainstrike/ui';
import { AlertTriangle, X } from 'lucide-react';
import {
  permissionPolicySelectors,
  usePermissionPolicyStore,
} from '../../stores/permission-policy-store';

interface RiskCategoryMeta {
  category: ToolRiskCategory;
  description: string;
  label: string;
}

/**
 * Ordered, user-facing metadata for each risk category. Keeping it as a literal
 * array (not derived) keeps the rendered order stable and the copy reviewable.
 */
const RISK_CATEGORY_META: readonly RiskCategoryMeta[] = [
  {
    category: 'read',
    description: 'Search and inspect the workspace (no changes).',
    label: 'Read',
  },
  {
    category: 'edit',
    description: 'Modify files or persistent state.',
    label: 'Edit',
  },
  {
    category: 'execute',
    description: 'Run commands or scripts.',
    label: 'Execute',
  },
  {
    category: 'mcp',
    description: 'Call external MCP server tools.',
    label: 'MCP',
  },
];

const DECISION_LABELS: Record<PermissionDecision, string> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
};

interface PolicySelectProps {
  category: ToolRiskCategory;
  disabled: boolean;
  label: string;
  onChange: (category: ToolRiskCategory, decision: PermissionDecision) => void;
  value: PermissionDecision;
}

function isPermissionDecisionValue(value: string): value is PermissionDecision {
  return (PERMISSION_DECISIONS as readonly string[]).includes(value);
}

/**
 * Accessible allow | ask | deny control for a single category, backed by a
 * native `<select>` (the same pattern as `assistant-memory-settings-section`).
 * Native semantics keep it keyboard/AT navigable without a Radix portal and
 * trivially testable. The `onChange` value is narrowed back to a
 * {@link PermissionDecision} before reaching the store.
 */
function PolicySelect({ category, disabled, label, onChange, value }: PolicySelectProps) {
  return (
    <select
      aria-label={`${label} permission`}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={`permission-policy-${category}`}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (isPermissionDecisionValue(next)) {
          onChange(category, next);
        }
      }}
      value={value}
    >
      {PERMISSION_DECISIONS.map((decision) => (
        <option key={decision} value={decision}>
          {DECISION_LABELS[decision]}
        </option>
      ))}
    </select>
  );
}

const CATEGORY_LABELS: Record<ToolRiskCategory, string> = {
  edit: 'Edit',
  execute: 'Execute',
  mcp: 'MCP',
  read: 'Read',
};

/**
 * Per-tool override rows + session-grant chips. Overrides are created from an
 * approval prompt ("Always allow this tool") or edited here; this section is the
 * management surface, so removal always lives next to what it removes.
 *
 * Deliberately NOT gated on `enforce`: overrides persist, so a user must be able
 * to remove or adjust stale ones even while enforcement is off (e.g. cleaning up
 * before re-enabling). The change simply has no runtime effect until enforcement
 * is back on — the top-level caveat already states that.
 */
function PerToolOverridesBlock() {
  const perToolOverrides = usePermissionPolicyStore(permissionPolicySelectors.perToolOverrides);
  const setToolOverride = usePermissionPolicyStore((state) => state.setToolOverride);
  const entries = Object.entries(perToolOverrides).sort(([a], [b]) => a.localeCompare(b));

  return (
    <fieldset className="space-y-3 border-0 p-0">
      <legend className="font-medium text-sm">Per-tool overrides</legend>
      <p className="text-muted-foreground text-sm">
        A per-tool decision beats its category policy. Add one from an approval prompt with{' '}
        <span className="font-medium">Always allow</span>, or adjust and remove overrides here.
      </p>
      {entries.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-3 text-muted-foreground text-sm"
          data-testid="permission-tool-overrides-empty"
        >
          No per-tool overrides yet.
        </p>
      ) : (
        entries.map(([toolId, decision]) => (
          <div
            className="flex items-center justify-between gap-4 rounded-md border p-3"
            key={toolId}
          >
            <p className="min-w-0 truncate font-mono text-sm">{toolId}</p>
            <div className="flex shrink-0 items-center gap-2">
              <select
                aria-label={`${toolId} override`}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                data-testid={`permission-tool-override-${toolId}`}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isPermissionDecisionValue(next)) {
                    setToolOverride(toolId, next);
                  }
                }}
                value={decision}
              >
                {PERMISSION_DECISIONS.map((option) => (
                  <option key={option} value={option}>
                    {DECISION_LABELS[option]}
                  </option>
                ))}
              </select>
              <Button
                aria-label={`Remove override for ${toolId}`}
                data-testid={`permission-tool-override-remove-${toolId}`}
                onClick={() => setToolOverride(toolId, null)}
                size="sm"
                title={`Remove override for ${toolId}`}
                variant="ghost"
              >
                <X className="size-3.5" />
                Remove
              </Button>
            </div>
          </div>
        ))
      )}
    </fieldset>
  );
}

/**
 * Active "allow for this session" grants; session-lived, cleared on reload.
 * Like the overrides block, revoke stays available regardless of `enforce` so a
 * user can always clear a stale grant.
 */
function SessionGrantsBlock() {
  const sessionGrants = usePermissionPolicyStore(permissionPolicySelectors.sessionGrants);
  const revokeSessionCategory = usePermissionPolicyStore((state) => state.revokeSessionCategory);
  // Taxonomy order (read → edit → execute → mcp), same source the category
  // cards use — no local duplicate of the ordering.
  const active = TOOL_RISK_CATEGORIES.filter((category) => sessionGrants.has(category));

  return (
    <fieldset className="space-y-3 border-0 p-0">
      <legend className="font-medium text-sm">Session grants</legend>
      <p className="text-muted-foreground text-sm">
        Categories allowed for this session only — cleared when the app reloads. Grant one from an
        approval prompt.
      </p>
      {active.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-3 text-muted-foreground text-sm"
          data-testid="permission-session-grants-empty"
        >
          No session grants active.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {active.map((category) => (
            <span
              className="inline-flex items-center gap-1 rounded-md border p-1 pl-3"
              key={category}
            >
              <span className="text-sm">{CATEGORY_LABELS[category]}</span>
              <Button
                aria-label={`Revoke session grant for ${CATEGORY_LABELS[category]}`}
                data-testid={`permission-session-grant-revoke-${category}`}
                onClick={() => revokeSessionCategory(category)}
                size="sm"
                title={`Revoke session grant for ${CATEGORY_LABELS[category]}`}
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            </span>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function PermissionSettingsSection() {
  const enforce = usePermissionPolicyStore(permissionPolicySelectors.enforce);
  const policies = usePermissionPolicyStore(permissionPolicySelectors.policies);
  const yolo = usePermissionPolicyStore(permissionPolicySelectors.yolo);
  const setEnforce = usePermissionPolicyStore((state) => state.setEnforce);
  const setCategoryPolicy = usePermissionPolicyStore((state) => state.setCategoryPolicy);
  const setYolo = usePermissionPolicyStore((state) => state.setYolo);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Permissions</CardTitle>
        <CardDescription>
          Control whether the assistant must check a policy before using its tools. Enforcement is
          on by default: read and MCP tools run normally, while edits and commands prompt you for
          approval first. Turn enforcement off to let the assistant use all tools without prompting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm" htmlFor="permission-enforce-toggle">
              Enforce tool permissions
            </Label>
            <p className="text-muted-foreground text-sm">
              On by default. Tool calls are evaluated against the policy below before they run;
              edits and commands prompt for approval. Turn off to opt out.
            </p>
          </div>
          <Switch
            checked={enforce}
            data-testid="permission-enforce-toggle"
            id="permission-enforce-toggle"
            onCheckedChange={(value) => setEnforce(value === true)}
          />
        </div>

        <fieldset className="space-y-3 border-0 p-0" disabled={!enforce}>
          <legend className="font-medium text-sm">Tool category policies</legend>
          <p className="text-muted-foreground text-sm">
            Choose how the assistant treats each category of tool. Per-category controls apply only
            while enforcement is on.
          </p>
          {RISK_CATEGORY_META.map(({ category, label, description }) => (
            <div
              className="flex items-center justify-between gap-4 rounded-md border p-3"
              key={category}
            >
              <div className="min-w-0">
                <p className="font-medium text-sm">{label}</p>
                <p className="text-muted-foreground text-sm">{description}</p>
              </div>
              <PolicySelect
                category={category}
                disabled={!enforce}
                label={label}
                onChange={setCategoryPolicy}
                value={policies[category]}
              />
            </div>
          ))}
        </fieldset>

        <PerToolOverridesBlock />

        <SessionGrantsBlock />

        <div
          className={cn(
            'flex items-start justify-between gap-4 rounded-md border p-3',
            yolo ? 'border-destructive/60 bg-destructive/5' : 'border-border'
          )}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Label className="font-medium text-sm" htmlFor="permission-yolo-toggle">
                YOLO mode
              </Label>
              {yolo ? (
                <Badge className="flex items-center gap-1" variant="destructive">
                  <AlertTriangle className="size-3.5" />
                  All tools allowed
                </Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground text-sm">
              Allow every tool for this session, ignoring the category policies above. Use with
              caution — this lets the assistant edit files and run commands without prompting.
            </p>
          </div>
          <Switch
            checked={yolo}
            data-testid="permission-yolo-toggle"
            id="permission-yolo-toggle"
            onCheckedChange={(value) => setYolo(value === true)}
          />
        </div>

        <p className="text-muted-foreground text-xs">
          Enforcement currently applies to the desktop assistant runtime. An{' '}
          <span className="font-medium">Ask</span> policy prompts you before the tool runs — approve
          to run it, decline to skip it.
        </p>
      </CardContent>
    </Card>
  );
}
