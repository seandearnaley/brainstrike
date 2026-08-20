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
  KIND_COPY,
  PROMPT_KINDS,
  type PromptDraft,
  type PromptModelSettingsDraft,
  type PromptWorkbenchModelOption,
  promptWorkbenchErrorMessage,
  toModelSettingsDraft,
} from './prompt-workbench-shared';

function toDraft(item: PromptItem | null): PromptDraft {
  return item
    ? {
        content: item.content,
        description: item.description ?? '',
        isFavorite: item.isFavorite,
        kind: item.kind,
        modelKey: item.modelKey ?? '',
        modelSettings: toModelSettingsDraft(item.modelSettings),
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
        modelSettings: toModelSettingsDraft(null),
        sourceUrl: '',
        tags: '',
        title: '',
      };
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
  const [draft, setDraft] = useState<PromptDraft>(() => toDraft(item));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const variables = useMemo(() => extractPromptTemplateVariables(draft.content), [draft.content]);
  const unavailableModelKey =
    draft.modelKey && !modelOptions.some((option) => option.key === draft.modelKey)
      ? draft.modelKey
      : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
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

        <form className="grid gap-4" onSubmit={submit}>
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

          <AdvancedModelSettings draft={draft} setDraft={setDraft} />

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
}: {
  readonly draft: PromptDraft;
  readonly setDraft: Dispatch<SetStateAction<PromptDraft>>;
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
          max={2}
          min={0}
          onChange={(value) => update('temperature', value)}
          step="0.01"
          value={draft.modelSettings.temperature}
        />
        <ModelSettingField
          id="prompt-builder-top-p"
          label="Top P"
          max={1}
          min={0}
          onChange={(value) => update('topP', value)}
          step="0.01"
          value={draft.modelSettings.topP}
        />
        <ModelSettingField
          id="prompt-builder-max-output-tokens"
          label="Max output tokens"
          min={1}
          onChange={(value) => update('maxOutputTokens', value)}
          step="1"
          value={draft.modelSettings.maxOutputTokens}
        />
        <ModelSettingField
          id="prompt-builder-frequency-penalty"
          label="Frequency penalty"
          max={2}
          min={-2}
          onChange={(value) => update('frequencyPenalty', value)}
          step="0.01"
          value={draft.modelSettings.frequencyPenalty}
        />
        <ModelSettingField
          id="prompt-builder-presence-penalty"
          label="Presence penalty"
          max={2}
          min={-2}
          onChange={(value) => update('presencePenalty', value)}
          step="0.01"
          value={draft.modelSettings.presencePenalty}
        />
      </div>
    </details>
  );
}

function ModelSettingField({
  id,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly max?: number;
  readonly min?: number;
  readonly onChange: (value: string) => void;
  readonly step: string;
  readonly value: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type="number"
        value={value}
      />
    </div>
  );
}
