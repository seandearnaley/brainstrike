import type { PromptItem } from '@brainstrike/db';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import { Braces, Star, WandSparkles } from 'lucide-react';
import { type Dispatch, type FormEvent, type SetStateAction, useMemo, useState } from 'react';
import { extractPromptTemplateVariables } from './prompt-template';
import {
  buildPromptModelSettings,
  KIND_COPY,
  PROMPT_EDITABLE_MODEL_SETTING_KEYS,
  PROMPT_KINDS,
  PROMPT_MODEL_SETTING_LIMITS,
  type PromptDraft,
  type PromptModelSettingsDraft,
  type PromptWorkbenchModelOption,
  promptWorkbenchErrorMessage,
  toModelSettingsDraft,
} from './prompt-workbench-shared';

function toDraft(
  item: PromptItem | null,
  modelSettings = toModelSettingsDraft(item?.modelSettings ?? null)
): PromptDraft {
  return item
    ? {
        content: item.content,
        description: item.description ?? '',
        isFavorite: item.isFavorite,
        kind: item.kind,
        modelKey: item.modelKey ?? '',
        modelSettings,
        sourceUrl: item.sourceUrl ?? '',
        tags: item.tags.join(', '),
        title: item.title,
      }
    : {
        content: '',
        description: '',
        isFavorite: false,
        kind: 'prompt',
        modelKey: '',
        modelSettings,
        sourceUrl: '',
        tags: '',
        title: '',
      };
}

function toInitialState(item: PromptItem | null): {
  readonly draft: PromptDraft;
  readonly error: string | null;
} {
  try {
    return { draft: toDraft(item), error: null };
  } catch (cause) {
    return {
      draft: toDraft(item, toModelSettingsDraft(null)),
      error: `${promptWorkbenchErrorMessage(cause)} Repair or clear the advanced settings before saving.`,
    };
  }
}

export function PromptBuilderDialog({
  item,
  modelOptions,
  onClose,
  onSave,
}: {
  readonly item: PromptItem | null;
  readonly modelOptions: readonly PromptWorkbenchModelOption[];
  readonly onClose: () => void;
  readonly onSave: (draft: PromptDraft) => Promise<void>;
}) {
  const [initialState] = useState(() => toInitialState(item));
  const [draft, setDraft] = useState<PromptDraft>(initialState.draft);
  const [error, setError] = useState<string | null>(initialState.error);
  const [saving, setSaving] = useState(false);
  const variables = useMemo(() => extractPromptTemplateVariables(draft.content), [draft.content]);
  const unavailableModelKey =
    draft.modelKey && !modelOptions.some((option) => option.key === draft.modelKey)
      ? draft.modelKey
      : null;
  const uneditableModelSettings = Object.entries(item?.modelSettings ?? {}).filter(
    ([key]) =>
      !PROMPT_EDITABLE_MODEL_SETTING_KEYS.includes(
        key as (typeof PROMPT_EDITABLE_MODEL_SETTING_KEYS)[number]
      )
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const modelSettings = buildPromptModelSettings(draft.modelSettings, item?.modelSettings);
      if (!draft.modelKey && modelSettings) {
        throw new Error('Choose a model or clear the advanced model settings before saving.');
      }
      setSaving(true);
      await onSave(draft);
      setSaving(false);
      onClose();
    } catch (cause) {
      setError(promptWorkbenchErrorMessage(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[min(90vh,780px)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 text-sky-600 dark:text-sky-300">
            <WandSparkles aria-hidden="true" className="size-4" />
            <span className="font-medium text-[11px] uppercase tracking-[0.16em]">
              Prompt builder
            </span>
          </div>
          <DialogTitle>{item ? `Edit ${item.title}` : 'Build a prompt'}</DialogTitle>
          <DialogDescription>
            Keep the intent separate from the reusable instruction. Variables use{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{name}}'}</code>.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" noValidate onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-title">Title</Label>
              <Input
                autoFocus
                id="prompt-builder-title"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="e.g. Adversarial code review"
                value={draft.title}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-kind">Type</Label>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="prompt-builder-kind"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    kind: event.target.value as PromptItem['kind'],
                  }))
                }
                value={draft.kind}
              >
                {PROMPT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_COPY[kind].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="prompt-builder-intention">Intention</Label>
            <Input
              id="prompt-builder-intention"
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="What job should this do, and when should it be recalled?"
              value={draft.description}
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="prompt-builder-content">Prompt text</Label>
              <span className="text-[10px] text-muted-foreground">
                {draft.content.length.toLocaleString()} characters
              </span>
            </div>
            <textarea
              className="min-h-48 w-full resize-y rounded-lg border border-input bg-background/80 px-3 py-3 font-mono text-[13px] leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              id="prompt-builder-content"
              onChange={(event) =>
                setDraft((current) => ({ ...current, content: event.target.value }))
              }
              placeholder="Write the reusable instruction…"
              required
              value={draft.content}
            />
            {variables.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-testid="prompt-builder-variables"
              >
                <Braces aria-hidden="true" className="size-3.5 text-sky-500" />
                {variables.map((variable) => (
                  <Badge className="font-mono font-normal" key={variable} variant="outline">
                    {variable}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-tags">Recall tags</Label>
              <Input
                id="prompt-builder-tags"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, tags: event.target.value }))
                }
                placeholder="review, evidence, security"
                value={draft.tags}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-model">Run with</Label>
              <select
                aria-label="Run with"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="prompt-builder-model"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, modelKey: event.target.value }))
                }
                value={draft.modelKey}
              >
                <option value="">Current thread model</option>
                {unavailableModelKey ? (
                  <option disabled value={unavailableModelKey}>
                    {`Unavailable · ${unavailableModelKey}`}
                  </option>
                ) : null}
                {modelOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-source">Source URL</Label>
              <Input
                id="prompt-builder-source"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, sourceUrl: event.target.value }))
                }
                placeholder="Optional provenance"
                type="url"
                value={draft.sourceUrl}
              />
            </div>
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm">
              <input
                checked={draft.isFavorite}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, isFavorite: event.target.checked }))
                }
                type="checkbox"
              />
              <Star aria-hidden="true" className="size-3.5" /> Favorite
            </label>
          </div>

          <AdvancedModelSettings
            draft={draft}
            setDraft={setDraft}
            uneditableSettings={uneditableModelSettings}
          />

          {error ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={saving || !draft.content.trim()} type="submit">
              {saving ? 'Saving…' : item ? 'Save changes' : 'Save prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AdvancedModelSettings({
  draft,
  setDraft,
  uneditableSettings,
}: {
  readonly draft: PromptDraft;
  readonly setDraft: Dispatch<SetStateAction<PromptDraft>>;
  readonly uneditableSettings: ReadonlyArray<readonly [string, unknown]>;
}) {
  const update = (key: keyof PromptModelSettingsDraft, value: string): void => {
    setDraft((current) => ({
      ...current,
      modelSettings: { ...current.modelSettings, [key]: value },
    }));
  };
  return (
    <details className="rounded-lg border border-border bg-muted/15">
      <summary className="cursor-pointer px-3 py-2 font-medium text-sm">
        Advanced model settings
      </summary>
      <div className="grid gap-3 border-border border-t p-3 sm:grid-cols-2">
        <ModelSettingField
          id="prompt-builder-temperature"
          label="Temperature"
          limitKey="temperature"
          onChange={(value) => update('temperature', value)}
          value={draft.modelSettings.temperature}
        />
        <ModelSettingField
          id="prompt-builder-top-p"
          label="Top P"
          limitKey="topP"
          onChange={(value) => update('topP', value)}
          value={draft.modelSettings.topP}
        />
        <ModelSettingField
          id="prompt-builder-max-output-tokens"
          label="Max output tokens"
          limitKey="maxOutputTokens"
          onChange={(value) => update('maxOutputTokens', value)}
          value={draft.modelSettings.maxOutputTokens}
        />
        <ModelSettingField
          id="prompt-builder-frequency-penalty"
          label="Frequency penalty"
          limitKey="frequencyPenalty"
          onChange={(value) => update('frequencyPenalty', value)}
          value={draft.modelSettings.frequencyPenalty}
        />
        <ModelSettingField
          id="prompt-builder-presence-penalty"
          label="Presence penalty"
          limitKey="presencePenalty"
          onChange={(value) => update('presencePenalty', value)}
          value={draft.modelSettings.presencePenalty}
        />
        {uneditableSettings.length > 0 ? (
          <div className="grid gap-2 rounded-md border border-border bg-background/70 p-3 sm:col-span-2">
            <p className="font-medium text-xs">Preserved uneditable settings</p>
            <p className="text-muted-foreground text-xs">
              These stored keys remain visible and are preserved unchanged on save.
            </p>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 font-mono text-xs">
              {uneditableSettings.map(([key, value]) => (
                <div className="contents" key={key}>
                  <dt className="truncate text-muted-foreground">{key}</dt>
                  <dd className="break-all">{JSON.stringify(value) ?? String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ModelSettingField({
  id,
  label,
  limitKey,
  onChange,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly limitKey: keyof typeof PROMPT_MODEL_SETTING_LIMITS;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const limits = PROMPT_MODEL_SETTING_LIMITS[limitKey];
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        max={'max' in limits ? limits.max : undefined}
        min={limits.min}
        onChange={(event) => onChange(event.target.value)}
        step={limits.step}
        type="number"
        value={value}
      />
    </div>
  );
}
