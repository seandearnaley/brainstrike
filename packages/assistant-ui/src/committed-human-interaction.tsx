import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { Button, Checkbox, Input } from '@brainstrike/ui';
import { type ComponentProps, type ReactElement, type Ref, useId, useState } from 'react';
import { usePlanModeExit } from './plan-mode-exit-context';

type ToolProps = ComponentProps<ToolCallMessagePartComponent>;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The committed request supplies the form; only its committed response resolves it.
 * `decisionRef` is the owning card's focus handoff: when the committed response
 * removes this form while one of its controls holds focus, focus moves to the card.
 */
export function CommittedHumanInteraction({
  decisionRef,
  tool,
}: {
  readonly decisionRef: Ref<HTMLFieldSetElement>;
  readonly tool: ToolProps;
}): ReactElement | null {
  const kind = tool.providerMetadata?.['brainstrike']?.['interactionKind'];
  const input = record(tool.args);
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const optionId = useId();
  // Approving a plan ends plan mode for the next message, as the legacy notice does.
  const exitPlanMode = usePlanModeExit();
  const approval = tool.approval;
  if (
    !(approval && approval.approved === undefined && approval.resolution === undefined) ||
    (kind !== 'question' && kind !== 'plan')
  ) {
    return null;
  }
  const options = Array.isArray(input['options']) ? input['options'].map(record) : [];
  const multi = input['selectionMode'] === 'multi_select';
  const send = (payload: unknown): void => {
    // The pressed control stays focusable (aria-disabled) while pending; refuse a repeat.
    if (sending) {
      return;
    }
    setSending(true);
    setError(undefined);
    void Promise.resolve()
      .then(() => tool.respondToApproval({ text: JSON.stringify(payload) }))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setSending(false);
      });
  };
  return (
    <fieldset
      aria-label={kind === 'question' ? 'Question for you' : 'Plan decision'}
      className="flex flex-col gap-2 px-3 pb-3"
      ref={decisionRef}
    >
      {kind === 'question' ? (
        <>
          <legend>{text(input['question'])}</legend>
          {options.map((option, index) => {
            const label = text(option['label']);
            return (
              <label
                className="flex items-center gap-2"
                htmlFor={`${optionId}-${index}`}
                key={label}
              >
                <Checkbox
                  checked={selected.includes(label)}
                  disabled={sending}
                  id={`${optionId}-${index}`}
                  onCheckedChange={(checked) => {
                    setSelected(
                      checked
                        ? multi
                          ? [...selected, label]
                          : [label]
                        : selected.filter((value) => value !== label)
                    );
                  }}
                />
                <span>
                  {label}
                  {option['description'] ? ` — ${text(option['description'])}` : ''}
                </span>
              </label>
            );
          })}
          <Input
            aria-label="Your answer"
            disabled={sending}
            onChange={(event) => setAnswer(event.target.value)}
            value={answer}
          />
          <Button
            aria-disabled={sending || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            disabled={!answer.trim() && selected.length === 0}
            onClick={() => send({ answer: answer.trim() || (multi ? selected : selected[0]) })}
          >
            Send answer
          </Button>
        </>
      ) : (
        <>
          <legend>{text(input['title'])}</legend>
          <p>{text(input['overview'])}</p>
          <ol className="list-decimal pl-5">
            {(Array.isArray(input['steps']) ? input['steps'].map(record) : []).map((step) => (
              <li key={text(step['title'])}>
                {text(step['title'])}
                {step['detail'] ? ` — ${text(step['detail'])}` : ''}
              </li>
            ))}
          </ol>
          {input['risks'] ? <p>{text(input['risks'])}</p> : null}
          {input['verification'] ? <p>{text(input['verification'])}</p> : null}
          <textarea
            aria-label="Plan feedback"
            className="rounded-md border bg-transparent p-2"
            disabled={sending}
            onChange={(event) => setAnswer(event.target.value)}
            value={answer}
          />
          <div className="flex gap-2">
            {(['approved', 'rejected'] as const).map((action) => (
              <Button
                aria-disabled={sending || undefined}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                key={action}
                onClick={() => {
                  if (action === 'approved') {
                    exitPlanMode?.();
                  }
                  send({ action, ...(answer.trim() ? { feedback: answer.trim() } : {}) });
                }}
                variant={action === 'approved' ? 'default' : 'outline'}
              >
                {action === 'approved' ? 'Approve plan' : 'Reject plan'}
              </Button>
            ))}
          </div>
        </>
      )}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </fieldset>
  );
}
