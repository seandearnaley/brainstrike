import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import type {
  AskUserOption,
  AskUserPayload,
  AssistantToolResumeAction,
  AssistantToolSuspendRequest,
  SubmitPlanPayload,
} from '@brainstrike/assistant-contract/tool-suspend';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/utils/logger';
import { Check, ListChecks, MessageCircleQuestion, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Button } from '../button';

const logger = createLogger('AssistantToolSuspendNotice');

const SUBMIT_PLAN_TOOL_ID = 'brainstrike.submitPlan';
const ASK_USER_TOOL_ID = 'brainstrike.askUser';

/**
 * Callback that clears the persisted plan-mode toggle. Provided by the
 * data-stream runtime and consumed by {@link SubmitPlanNotice} so APPROVING a
 * plan exits plan mode BEFORE the resume request is composed — the rebuilt
 * server runtime then omits `planMode` and unlocks the mutation tools. REJECT
 * leaves plan mode on so the model can revise. `null` when plan mode is not
 * wired (e.g. non-desktop transports).
 */
const PlanModeExitContext = createContext<(() => void) | null>(null);

export function PlanModeExitProvider({
  children,
  onExit,
}: {
  children: ReactNode;
  onExit: (() => void) | null | undefined;
}) {
  return (
    <PlanModeExitContext.Provider value={onExit ?? null}>{children}</PlanModeExitContext.Provider>
  );
}

function usePlanModeExit(): (() => void) | null {
  return useContext(PlanModeExitContext);
}

interface AssistantToolSuspendNoticeProps {
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAssistantToolSuspendRequest(value: unknown): value is AssistantToolSuspendRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string'
  );
}

function isMatchingResumeAction(value: unknown, request: AssistantToolSuspendRequest): boolean {
  return (
    isRecord(value) &&
    value['runId'] === request.runId &&
    value['toolCallId'] === request.toolCallId
  );
}

function getResumeActionFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? custom[TOOL_SUSPEND_RUN_CONFIG_KEY] : undefined;
}

function getMessageRole(message: unknown): unknown {
  return isRecord(message) ? message['role'] : undefined;
}

function getMessageStatusType(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return;
  }
  const status = message['status'];
  return isRecord(status) && typeof status['type'] === 'string' ? status['type'] : undefined;
}

/**
 * Lifecycle of the run kicked off by a resume for THIS suspended call:
 *   - `none`       — no matching resume appended yet.
 *   - `pending`    — a resume is in flight (still streaming, or awaiting a new run).
 *   - `retryable`  — the resumed run FAILED (assistant status `incomplete`); the
 *                    controls RE-ENABLE so the user can resubmit (mirrors the
 *                    approval notice — a stale/failed resume must not lock forever).
 *   - `completed`  — the resumed run finished successfully; controls stay locked.
 */
type SuspendRunOutcomeState = 'none' | 'pending' | 'retryable' | 'completed';

/**
 * Scan the thread for a `user` message carrying a matching `brainstrikeToolSuspend`
 * action, then classify the run that followed it. Mirrors the approval notice's
 * `resolveApprovalRunOutcome`: a failed resume is `retryable` (controls unlock),
 * never permanently locked.
 */
function resolveSuspendRunOutcome(
  messages: readonly unknown[],
  request: AssistantToolSuspendRequest | null
): SuspendRunOutcomeState {
  if (!request) {
    return 'none';
  }
  let submittedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      getMessageRole(message) === 'user' &&
      isMatchingResumeAction(getResumeActionFromMessage(message), request)
    ) {
      submittedIndex = index;
      break;
    }
  }
  if (submittedIndex < 0) {
    return 'none';
  }

  for (let index = submittedIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const role = getMessageRole(message);
    if (role === 'user') {
      return 'pending';
    }
    if (role !== 'assistant') {
      continue;
    }
    const statusType = getMessageStatusType(message);
    if (statusType === 'complete') {
      return 'completed';
    }
    if (statusType === 'incomplete') {
      return 'retryable';
    }
    return 'pending';
  }
  return 'pending';
}

/**
 * Shared resume-append hook for both suspend notices. Appends a `user` message
 * carrying the branch-specific `resumeData` under the suspend run-config key and
 * starts the run. Locks after submit (local state OR a still-running/completed
 * resume in the thread); a FAILED resume re-enables the controls so the user can
 * retry (see {@link resolveSuspendRunOutcome}).
 */
function useSuspendResume(request: AssistantToolSuspendRequest | null) {
  const aui = useAui();
  const [submitted, setSubmitted] = useState(false);
  const runOutcome = useAuiState((state) =>
    resolveSuspendRunOutcome(state.thread.messages, request)
  );
  const lockedByRun = runOutcome === 'pending' || runOutcome === 'completed';
  const locked = submitted || lockedByRun;

  // A failed resume (`retryable`) must clear the optimistic local lock so the
  // buttons re-enable for a retry — mirrors the approval notice's reset effect.
  useEffect(() => {
    if (!submitted || runOutcome !== 'retryable') {
      return;
    }
    setSubmitted(false);
  }, [runOutcome, submitted]);

  const submit = useCallback(
    (resumeData: unknown, summary: string): void => {
      if (!request || locked) {
        return;
      }
      const action: AssistantToolResumeAction = {
        resumeData,
        runId: request.runId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
      };
      const message = {
        content: [{ text: summary, type: 'text' }],
        metadata: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
        role: 'user',
        runConfig: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
        startRun: true,
      } satisfies CreateAppendMessage;

      setSubmitted(true);
      try {
        void Promise.resolve(aui.thread().append(message)).catch((error: unknown) => {
          setSubmitted(false);
          logger.warn('Failed to append tool resume action', {
            error,
            runId: request.runId,
            toolCallId: request.toolCallId,
          });
        });
      } catch (error) {
        setSubmitted(false);
        logger.warn('Failed to append tool resume action', {
          error,
          runId: request.runId,
          toolCallId: request.toolCallId,
        });
      }
    },
    [aui, locked, request]
  );

  return { locked, submit };
}

function NoticeShell({
  children,
  icon,
  testId,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  testId: string;
  title: string;
}) {
  return (
    <div
      className="my-2 rounded-lg border border-sky-500/40 bg-sky-50/50 dark:bg-sky-950/20"
      data-testid={testId}
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 px-4 py-3">
        <div aria-hidden="true" className="pt-0.5 text-sky-700 dark:text-sky-400">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function SubmitPlanNotice({ request }: { request: AssistantToolSuspendRequest }) {
  const { submit, locked } = useSuspendResume(request);
  const exitPlanMode = usePlanModeExit();
  const [feedback, setFeedback] = useState('');
  const plan = isRecord(request.suspendPayload)
    ? (request.suspendPayload as unknown as SubmitPlanPayload)
    : null;

  const approve = useCallback(() => {
    // Exit plan mode BEFORE composing the resume request so the rebuilt server
    // runtime unlocks the mutation tools for the approved plan. Reject keeps
    // plan mode on (handled by NOT calling this on the reject path).
    exitPlanMode?.();
    submit(
      feedback.trim() ? { action: 'approved', feedback: feedback.trim() } : { action: 'approved' },
      'Approved the plan.'
    );
  }, [exitPlanMode, feedback, submit]);

  return (
    <NoticeShell
      icon={<ListChecks className="size-4" />}
      testId="assistant-submit-plan-notice"
      title={plan?.title ? `Plan: ${plan.title}` : 'Plan for your approval'}
    >
      {plan ? (
        <div className="mt-1 space-y-2 text-xs">
          <p className="text-foreground/90">{plan.overview}</p>
          {plan.steps?.length ? (
            <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
              {plan.steps.map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are an immutable, never-reordered slice of one suspend payload; the index disambiguates duplicate title/detail pairs that collide on a content-only key.
                <li key={`${index}:${step.title}:${step.detail ?? ''}`}>
                  <span className="text-foreground/90">{step.title}</span>
                  {step.detail ? (
                    <span className="text-muted-foreground"> — {step.detail}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {plan.risks ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground/90">Risks: </span>
              {plan.risks}
            </p>
          ) : null}
          {plan.verification ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground/90">Verification: </span>
              {plan.verification}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-muted-foreground text-xs">A plan was submitted for your review.</p>
      )}
      <textarea
        aria-label="Feedback for the plan"
        className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        disabled={locked}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="Optional feedback (sent on Reject so the plan can be revised)…"
        rows={2}
        value={feedback}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button disabled={locked} onClick={approve} size="sm" variant="default">
          <Check className="size-3.5" />
          Approve
        </Button>
        <Button
          disabled={locked}
          onClick={() =>
            submit(
              feedback.trim()
                ? { action: 'rejected', feedback: feedback.trim() }
                : { action: 'rejected' },
              'Rejected the plan.'
            )
          }
          size="sm"
          variant="outline"
        >
          <X className="size-3.5" />
          Reject
        </Button>
      </div>
    </NoticeShell>
  );
}

function AskUserNotice({ request }: { request: AssistantToolSuspendRequest }) {
  const { submit, locked } = useSuspendResume(request);
  const [freeText, setFreeText] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const payload = isRecord(request.suspendPayload)
    ? (request.suspendPayload as unknown as AskUserPayload)
    : null;
  const options: AskUserOption[] = payload?.options ?? [];
  const isMultiSelect = payload?.selectionMode === 'multi_select';

  const toggle = useCallback((label: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  return (
    <NoticeShell
      icon={<MessageCircleQuestion className="size-4" />}
      testId="assistant-ask-user-notice"
      title={payload?.question ?? 'The assistant has a question'}
    >
      {options.length === 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="Your answer"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            disabled={locked}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Type your answer…"
            value={freeText}
          />
          <Button
            disabled={locked || freeText.trim().length === 0}
            onClick={() => submit(freeText.trim(), `Answered: ${freeText.trim()}`)}
            size="sm"
            variant="default"
          >
            Send
          </Button>
        </div>
      ) : isMultiSelect ? (
        <div className="mt-2 space-y-1.5">
          {options.map((option) => (
            <label className="flex items-start gap-2 text-xs" key={option.label}>
              <input
                checked={selected.has(option.label)}
                disabled={locked}
                onChange={() => toggle(option.label)}
                type="checkbox"
              />
              <span>
                <span className="text-foreground/90">{option.label}</span>
                {option.description ? (
                  <span className="text-muted-foreground"> — {option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
          <Button
            className="mt-1"
            disabled={locked || selected.size === 0}
            onClick={() => {
              const answers = Array.from(selected);
              submit(answers, `Answered: ${answers.join(', ')}`);
            }}
            size="sm"
            variant="default"
          >
            Submit
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              disabled={locked}
              key={option.label}
              onClick={() => submit(option.label, `Answered: ${option.label}`)}
              size="sm"
              title={option.description ?? option.label}
              variant="outline"
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </NoticeShell>
  );
}

export function AssistantToolSuspendNotice({ data }: AssistantToolSuspendNoticeProps) {
  const request = isAssistantToolSuspendRequest(data) ? data : null;
  const detail = useMemo(
    () => (request ? JSON.stringify(request.suspendPayload, null, 2) : ''),
    [request]
  );
  if (!request) {
    return null;
  }
  if (request.toolName === SUBMIT_PLAN_TOOL_ID) {
    return <SubmitPlanNotice request={request} />;
  }
  if (request.toolName === ASK_USER_TOOL_ID) {
    return <AskUserNotice request={request} />;
  }
  // Unknown suspending tool: render a generic, non-actionable fallback rather
  // than a wrong-typed action (no-silent-wrong-render).
  return (
    <NoticeShell
      icon={<MessageCircleQuestion className="size-4" />}
      testId="assistant-tool-suspend-notice"
      title={`Waiting on input for ${request.toolName}`}
    >
      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
        {detail}
      </pre>
    </NoticeShell>
  );
}

AssistantToolSuspendNotice.displayName = 'AssistantToolSuspendNotice';
