/**
 * Permissions settings section (permission engine, step 4b / PR-1.4b).
 *
 * A real product surface for configuring the permission engine that lives in
 * `permission-policy-store.ts`. It CONSUMES the store only — no engine/store
 * logic lives here:
 * - the master `enforce` toggle (ON by default; users can opt out),
 * - a per-`ToolRiskCategory` policy control (allow | ask | deny),
 * - the access mode the composer also sets (ask | auto | full) and auto
 *   mode's quick model.
 *
 * Honest-surface caveats (no over-claiming): enforcement currently applies to
 * the desktop assistant runtime, where an `'ask'` policy now PROMPTS for per-call
 * approval (approve runs the tool, decline skips it). Those caveats are stated
 * inline rather than implied away.
 */

import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  discardSavedPermissionPolicy,
  permissionPolicySelectors,
  rehydratePermissionPolicy,
  usePermissionPolicyHydration,
  usePermissionPolicySave,
  usePermissionPolicyStore,
} from '@brainstrike/app-state/stores/permission-policy-store';
import {
  ACCESS_MODES,
  type AccessMode,
  AUTO_REVIEW_MODEL_AUTO,
  isAccessMode,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorNotice,
  Label,
  ModelSelect,
  Switch,
} from '@brainstrike/ui';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { listObservationalMemoryModelOptions } from '../models/assistant-memory-models';

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
      className="border-input bg-background h-9 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
      <legend className="text-sm font-medium">Per-tool overrides</legend>
      <p className="text-muted-foreground text-sm">
        A per-tool decision beats its category policy. Add one from an approval prompt with{' '}
        <span className="font-medium">Always allow</span>, or adjust and remove overrides here.
      </p>
      {entries.length === 0 ? (
        <p
          className="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
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
                className="border-input bg-background h-9 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                data-testid={`permission-tool-override-${toolId}`}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isPermissionDecisionValue(next)) {
                    void setToolOverride(toolId, next);
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
                onClick={() => void setToolOverride(toolId, null)}
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

/** Asks before a bulk action that cannot be undone: Cancel, then the action. */
function ConfirmActionDialog({
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
}: {
  readonly confirmLabel: string;
  readonly description: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
            type="button"
            variant="destructive"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const clearSessionGrants = usePermissionPolicyStore((state) => state.clearSessionGrants);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  // Taxonomy order (read → edit → execute → mcp), same source the category
  // cards use — no local duplicate of the ordering.
  const active = TOOL_RISK_CATEGORIES.filter((category) => sessionGrants.has(category));

  return (
    <fieldset className="space-y-3 border-0 p-0">
      <legend className="text-sm font-medium">Session grants</legend>
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Categories allowed for this session only — cleared when the app reloads. Grant one from an
          approval prompt.
        </p>
        {active.length > 0 ? (
          <Button
            aria-label="Revoke all session grants"
            className="shrink-0"
            data-testid="permission-session-grants-revoke-all"
            onClick={() => setConfirmingRevokeAll(true)}
            size="sm"
            title="Revoke every session grant at once"
            variant="ghost"
          >
            <X className="size-3.5" />
            Revoke all
          </Button>
        ) : null}
      </div>
      {active.length === 0 ? (
        <p
          className="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
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
      <ConfirmActionDialog
        confirmLabel="Revoke all"
        description="Every category allowed for this session goes back to its policy, so its next tool call asks again."
        onConfirm={() => clearSessionGrants()}
        onOpenChange={setConfirmingRevokeAll}
        open={confirmingRevokeAll}
        title="Revoke all session grants?"
      />
    </fieldset>
  );
}

const ACCESS_MODE_META: Record<AccessMode, { description: string; label: string }> = {
  ask: {
    description: 'Every call the policy above asks about waits for you.',
    label: 'Ask for approval',
  },
  auto: {
    description:
      'A quick model reviews each of those calls first. It runs the ones it judges routine and covered by your request, and asks you about the rest, or whenever the review fails.',
    label: 'Auto',
  },
  full: {
    description:
      'Every tool runs without asking, ignoring the category policies above. Explicit denies still apply.',
    label: 'Full access',
  },
};

/**
 * The composer's access mode, and auto mode's quick model. The model list is
 * the enabled hosted LLMs; Auto picks the chat provider's own quick model, so
 * the review never reaches a provider that is not already in the conversation.
 */
function AccessModeBlock({ disabled }: { disabled: boolean }) {
  useEnsureModelRegistry();
  const access = usePermissionPolicyStore(permissionPolicySelectors.access);
  const autoReviewModel = usePermissionPolicyStore(permissionPolicySelectors.autoReviewModel);
  const setAccess = usePermissionPolicyStore((state) => state.setAccess);
  const setAutoReviewModel = usePermissionPolicyStore((state) => state.setAutoReviewModel);
  const { models, providers } = useModelRegistryStore(
    useShallow((state) => ({ models: state.models, providers: state.providers }))
  );
  const options = listObservationalMemoryModelOptions({
    assistantMemoryBackendAvailable: true,
    models,
    providers,
  });
  const known =
    autoReviewModel === AUTO_REVIEW_MODEL_AUTO ||
    options.some((option) => option.target === autoReviewModel);

  return (
    <fieldset
      className={cn(
        'space-y-3 rounded-md border p-3',
        access === 'full' ? 'border-destructive/60 bg-destructive/5' : 'border-border'
      )}
      disabled={disabled}
    >
      <legend className="sr-only">Access mode</legend>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium" htmlFor="permission-access-mode">
              Access mode
            </Label>
            {access === 'full' ? (
              <Badge className="flex items-center gap-1" variant="destructive">
                <AlertTriangle className="size-3.5" />
                All tools allowed
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">{ACCESS_MODE_META[access].description}</p>
        </div>
        <select
          className="border-input bg-background h-9 shrink-0 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="permission-access-mode"
          id="permission-access-mode"
          onChange={(event) => {
            const next = event.target.value;
            if (isAccessMode(next)) {
              void setAccess(next);
            }
          }}
          value={access}
        >
          {ACCESS_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {ACCESS_MODE_META[mode].label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-medium" htmlFor="permission-auto-review-model">
          Auto-review model
        </Label>
        <ModelSelect
          className="max-w-64"
          data-testid="permission-auto-review-model"
          disabled={disabled}
          id="permission-auto-review-model"
          onValueChange={(value) => void setAutoReviewModel(value)}
          options={[
            // Auto reviews on the chat's own provider, so no other provider sees the call.
            { label: 'Auto (chat’s provider)', value: AUTO_REVIEW_MODEL_AUTO },
            ...(known ? [] : [{ label: autoReviewModel, value: autoReviewModel }]),
            ...options.map((option) => ({
              label: option.label,
              markLabel: option.markLabel,
              provider: option.providerId,
              value: option.target,
              vendor: option.vendor,
            })),
          ]}
          value={autoReviewModel}
        />
      </div>
    </fieldset>
  );
}

export function PermissionSettingsSection() {
  const hydration = usePermissionPolicyHydration();
  const enforce = usePermissionPolicyStore(permissionPolicySelectors.enforce);
  const policies = usePermissionPolicyStore(permissionPolicySelectors.policies);
  const setEnforce = usePermissionPolicyStore((state) => state.setEnforce);
  const setCategoryPolicy = usePermissionPolicyStore((state) => state.setCategoryPolicy);
  const saveError = usePermissionPolicySave((state) => state.error);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // BST-1930: editing defaults while the host is still opening can overwrite
  // saved policy and lose the pending write when the user immediately quits.
  if (hydration.status !== 'ready') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tool policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {hydration.status === 'failed' ? (
            <>
              <ErrorNotice
                message={`Unable to load permission settings: ${hydration.error}`}
                onRetry={hydration.unreadable ? undefined : () => void rehydratePermissionPolicy()}
              />
              {hydration.unreadable ? (
                <>
                  <Button onClick={() => setConfirmingReset(true)}>Reset to defaults</Button>
                  <ConfirmActionDialog
                    confirmLabel="Reset to defaults"
                    description="This discards the saved permission settings and starts again from the defaults. It cannot be undone."
                    onConfirm={() => void discardSavedPermissionPolicy()}
                    onOpenChange={setConfirmingReset}
                    open={confirmingReset}
                    title="Reset permission settings?"
                  />
                </>
              ) : null}
            </>
          ) : (
            <p role="status">Loading permission settings…</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool policy</CardTitle>
        <CardDescription>
          Control whether the assistant must check a policy before using its tools. Enforcement is
          on by default: read and MCP tools run normally, while edits and commands prompt you for
          approval first. Turn enforcement off to let the assistant use all tools without prompting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {saveError === null ? null : (
          <p data-testid="permission-policy-save-error" role="alert">
            Unable to save permission settings: {saveError}
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium" htmlFor="permission-enforce-toggle">
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
            onCheckedChange={(value) => void setEnforce(value === true)}
          />
        </div>

        <fieldset className="space-y-3 border-0 p-0" disabled={!enforce}>
          <legend className="text-sm font-medium">Tool category policies</legend>
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
                <p className="text-sm font-medium">{label}</p>
                <p className="text-muted-foreground text-sm">{description}</p>
              </div>
              <PolicySelect
                category={category}
                disabled={!enforce}
                label={label}
                onChange={(category, decision) => void setCategoryPolicy(category, decision)}
                value={policies[category]}
              />
            </div>
          ))}
        </fieldset>

        <PerToolOverridesBlock />

        <SessionGrantsBlock />

        <AccessModeBlock disabled={!enforce} />

        <p className="text-muted-foreground text-xs">
          Enforcement currently applies to the desktop assistant runtime. An{' '}
          <span className="font-medium">Ask</span> policy prompts you before the tool runs — approve
          to run it, decline to skip it.
        </p>
      </CardContent>
    </Card>
  );
}
