/**
 * Argument entry for one selected MCP server prompt (BST-1592).
 *
 * The pinned `@assistant-ui/react` trigger popover closes at the first
 * whitespace after `/id`, so INLINE `/prompt arg` capture is unreachable in the
 * live flow (see docs/agents/workspace-context.md, "Arguments — placeholder-fill").
 * Argument-taking prompts therefore collect their values here, in the same
 * modal language as the MCP elicitation consent dialog, with suggestions from
 * `completion/complete` (`ref/prompt`).
 *
 * The title line names the CONFIGURED SERVER: two servers may expose the same
 * prompt name, and the user must always know whose prompt they are about to
 * stage. When the server goes away mid-selection the dialog stays open, says so,
 * and disables submission — it never silently retargets another generation.
 */
import {
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
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { McpPromptEntry } from './mcp-prompt-catalog';

/** Keystrokes collapse into one `completion/complete` round trip per pause. */
const COMPLETION_DEBOUNCE_MS = 250;
/** Bound for suggestion values rendered for one argument. */
const SUGGESTION_LIMIT = 20;

export interface McpPromptCompletionRequest {
  readonly argument: string;
  /** The other arguments already filled, so the server can narrow its suggestions. */
  readonly context: Readonly<Record<string, string>>;
  readonly value: string;
}

export interface McpPromptDialogProps {
  readonly entry: McpPromptEntry;
  readonly onCancel: () => void;
  /**
   * Absent when the server does not advertise `completion/complete`: a server
   * without it would fail every keystroke, so the affordance is not offered.
   */
  readonly onRequestCompletion?:
    | ((request: McpPromptCompletionRequest) => Promise<readonly string[]>)
    | undefined;
  readonly onSubmit: (values: Readonly<Record<string, string>>) => Promise<void>;
  /** Set once the pinned server generation is no longer a live authority. */
  readonly retiredReason?: string | undefined;
}

interface Suggestions {
  readonly argument: string;
  readonly values: readonly string[];
}

function filledArguments(
  values: Readonly<Record<string, string>>,
  exclude: string
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values).filter(([name, value]) => name !== exclude && value !== '')
  );
}

export function McpPromptDialog({
  entry,
  onCancel,
  onRequestCompletion,
  onSubmit,
  retiredReason,
}: McpPromptDialogProps) {
  const idPrefix = useId();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const completionSequenceRef = useRef(0);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = submitting || retiredReason !== undefined;

  const cancelPendingCompletion = useCallback((): void => {
    completionSequenceRef.current += 1;
    if (completionTimerRef.current !== null) {
      clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelPendingCompletion, [cancelPendingCompletion]);

  const requestSuggestions = (
    argument: string,
    value: string,
    next: Record<string, string>
  ): void => {
    cancelPendingCompletion();
    if (!onRequestCompletion || value === '') {
      setSuggestions(null);
      return;
    }
    const sequence = completionSequenceRef.current;
    completionTimerRef.current = setTimeout(() => {
      completionTimerRef.current = null;
      onRequestCompletion({ argument, context: filledArguments(next, argument), value }).then(
        (resolved) => {
          if (sequence === completionSequenceRef.current) {
            setCompletionError(null);
            setSuggestions({
              argument,
              values: [...new Set(resolved)].slice(0, SUGGESTION_LIMIT),
            });
          }
        },
        (cause: unknown) => {
          if (sequence === completionSequenceRef.current) {
            setSuggestions(null);
            setCompletionError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      );
    }, COMPLETION_DEBOUNCE_MS);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const missing = entry.arguments.find(
      (argument) => argument.required && (values[argument.name] ?? '') === ''
    );
    if (missing) {
      setFormError(`Prompt argument ${missing.name} is required`);
      return;
    }
    cancelPendingCompletion();
    setFormError(null);
    setSubmitError(null);
    setSubmitting(true);
    void onSubmit(
      Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
    ).catch((cause: unknown) => {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    });
  };

  return (
    // `onOpenChange` is deliberately NOT gated on `submitting`: Escape and an
    // outside click stay available while `prompts/get` is in flight, because a
    // modal the user cannot dismiss is worse than one they can. The abort is
    // honoured where it matters — `McpPromptComposerHost.stage()` re-reads the
    // selection after the await and refuses to stage a dismissed request — so
    // closing here can never leave the prompt text in the composer anyway. The
    // Cancel BUTTON stays disabled while submitting so the footer does not
    // advertise an action whose in-flight request it cannot recall.
    <Dialog onOpenChange={() => onCancel()} open={true}>
      <DialogContent
        aria-busy={submitting || undefined}
        className="max-w-lg"
        data-testid="mcp-prompt-dialog"
      >
        <form className="space-y-4" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Insert prompt “{entry.title}”</DialogTitle>
            <DialogDescription>
              From configured MCP server “{entry.configuredServerId}”. The prompt is staged in the
              composer for you to read and edit — nothing is sent until you send it.
            </DialogDescription>
          </DialogHeader>
          {entry.description ? (
            <p className="whitespace-pre-wrap text-muted-foreground text-sm">{entry.description}</p>
          ) : null}
          <div className="space-y-3">
            {entry.arguments.map((argument) => {
              const controlId = `${idPrefix}-${argument.name}`;
              const listId = `${controlId}-options`;
              const hasSuggestions = suggestions?.argument === argument.name;
              return (
                <div className="space-y-1" key={argument.name}>
                  <Label htmlFor={controlId}>
                    {argument.name}
                    {argument.required ? (
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    ) : null}
                  </Label>
                  <Input
                    autoComplete="off"
                    disabled={busy}
                    id={controlId}
                    list={hasSuggestions ? listId : undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      const next = { ...values, [argument.name]: value };
                      setFormError(null);
                      setValues(next);
                      requestSuggestions(argument.name, value, next);
                    }}
                    required={argument.required}
                    value={values[argument.name] ?? ''}
                  />
                  {hasSuggestions ? (
                    <datalist id={listId}>
                      {suggestions.values.map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  ) : null}
                  {argument.description ? (
                    <p className="text-muted-foreground text-xs">{argument.description}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {completionError ? (
            <p className="text-destructive text-xs">
              Argument autocomplete failed: {completionError}
            </p>
          ) : null}
          {formError ? (
            <p className="text-destructive text-sm" role="alert">
              {formError}
            </p>
          ) : null}
          {submitError ? (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          ) : null}
          {retiredReason ? (
            <p className="text-destructive text-sm" role="alert">
              {retiredReason}
            </p>
          ) : null}
          <DialogFooter>
            <Button disabled={submitting} onClick={onCancel} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={busy} type="submit">
              Insert prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
