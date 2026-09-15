import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import { getToolActionIdentityKey, getToolActionTarget } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import type {
  AskUserOption,
  AskUserPayload,
  AskUserResumeData,
  AssistantToolResumeAction,
  AssistantToolSuspendRequest,
  RegisteredSuspendResumeToolId,
  SubmitPlanPayload,
} from '@brainstrike/assistant-contract/tool-suspend';
import {
  hasRegisteredSuspendResumeUi,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger, redactSensitiveLogValue } from '@brainstrike/logging';
import { Button, Checkbox } from '@brainstrike/ui';
import { Check, Globe, ListChecks, MessageCircleQuestion, TriangleAlert, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { submitDecisionOrQueue } from './decision-dispatch';
import { followUpQueueKey, isDecisionQueued, useFollowUpQueueStore } from './follow-up-queue-store';
import { useLiveDecisionTransport } from './live-decision-transport';
import { readRediscoveredPauseDisplay } from './rediscovered-pause-display';
import { RediscoveredPauseLines } from './rediscovered-pause-lines';
import {
  isAssistantToolSuspendRequest,
  resolveSuspendRunOutcome,
} from './tool-decision-run-outcome';
import { rememberUnreadablePauseLogIdentity } from './unreadable-pause-log-cache';

const logger = createLogger('AssistantToolSuspendNotice');

const SUBMIT_PLAN_TOOL_ID = NATIVE_TOOL_ID.submitPlan;
const ASK_USER_TOOL_ID = NATIVE_TOOL_ID.askUser;
const SUSPEND_PAYLOAD_DIAGNOSTIC_CHAR_LIMIT = 4000;

function serializeSuspendPayloadDiagnostic(suspendPayload: unknown): string {
  const serialized =
    JSON.stringify(redactSensitiveLogValue(suspendPayload), null, 2) ?? 'undefined';
  return serialized.length > SUSPEND_PAYLOAD_DIAGNOSTIC_CHAR_LIMIT
    ? `${serialized.slice(0, SUSPEND_PAYLOAD_DIAGNOSTIC_CHAR_LIMIT)}\n… (truncated)`
    : serialized;
}

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
  return use(PlanModeExitContext);
}

interface AssistantToolSuspendNoticeProps {
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readSubmitPlanPayload(value: unknown): SubmitPlanPayload | null | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    return null;
  }
  const { overview, risks, steps, title, verification } = value;
  if (typeof overview !== 'string' || typeof title !== 'string' || !Array.isArray(steps)) {
    return null;
  }

  const parsedSteps: SubmitPlanPayload['steps'] = [];
  for (const step of steps) {
    if (!isRecord(step) || typeof step['title'] !== 'string') {
      return null;
    }
    parsedSteps.push({
      ...(typeof step['detail'] === 'string' ? { detail: step['detail'] } : {}),
      title: step['title'],
    });
  }

  return {
    overview,
    ...(typeof risks === 'string' ? { risks } : {}),
    steps: parsedSteps,
    title,
    ...(typeof verification === 'string' ? { verification } : {}),
  };
}

function readAskUserOptions(options: unknown): AskUserOption[] | null | undefined {
  if (options === undefined) {
    return;
  }
  if (!Array.isArray(options)) {
    return null;
  }
  const parsedOptions: AskUserOption[] = [];
  for (const option of options) {
    if (!isRecord(option) || typeof option['label'] !== 'string') {
      return null;
    }
    parsedOptions.push({
      ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}),
      label: option['label'],
    });
  }
  return parsedOptions;
}

function readAskUserPayload(value: unknown): AskUserPayload | null | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    return null;
  }
  const { options, question, selectionMode } = value;
  if (typeof question !== 'string') {
    return null;
  }
  const parsedOptions = readAskUserOptions(options);
  if (parsedOptions === null) {
    return null;
  }
  if (
    selectionMode !== undefined &&
    selectionMode !== 'single_select' &&
    selectionMode !== 'multi_select'
  ) {
    return null;
  }
  if (selectionMode !== undefined && (!parsedOptions || parsedOptions.length === 0)) {
    return null;
  }

  return {
    ...(parsedOptions ? { options: parsedOptions } : {}),
    question,
    ...(selectionMode === 'single_select' || selectionMode === 'multi_select'
      ? { selectionMode }
      : {}),
  };
}

function readAskUserQuestion(value: unknown): string | null {
  return isRecord(value) && typeof value['question'] === 'string' ? value['question'] : null;
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
  // A failed resume (`retryable`) must clear the optimistic local lock so the
  // buttons re-enable for a retry. Adjust the state during render on the
  // TRANSITION into `retryable` (prev-outcome comparison) instead of via an
  // effect — routing it through useEffect forces an extra render with a stale,
  // still-locked UI between commits. Same net behavior as the approval notice's
  // reset, without a set-state-in-effect cascade.
  const [prevRunOutcome, setPrevRunOutcome] = useState(runOutcome);
  if (runOutcome !== prevRunOutcome) {
    setPrevRunOutcome(runOutcome);
    if (submitted && runOutcome === 'retryable') {
      setSubmitted(false);
    }
  }
  const lockedByRun = runOutcome === 'pending' || runOutcome === 'completed';
  const threadKey = use(ActiveThreadKeyContext);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const deliverLive = useLiveDecisionTransport();
  const queued = useFollowUpQueueStore((state) =>
    request
      ? isDecisionQueued(state, followUpQueueKey(threadKey), getToolActionIdentityKey(request))
      : false
  );
  const locked =
    queued ||
    submitted ||
    lockedByRun ||
    readRediscoveredPauseDisplay(request)?.decisionState !== undefined;

  const submit = useCallback(
    (resumeData: unknown, summary: string): void => {
      if (!request || locked) {
        return;
      }
      const action: AssistantToolResumeAction = {
        resumeData,
        ...getToolActionTarget(request),
        toolName: request.toolName,
      };
      const message = {
        content: [{ text: summary, type: 'text' }],
        metadata: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
        role: 'user',
        runConfig: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } },
        startRun: true,
      } satisfies CreateAppendMessage;

      const sendNow = (queued: CreateAppendMessage): void => {
        setSubmitted(true);
        try {
          void Promise.resolve(aui.thread().append(queued)).catch((error: unknown) => {
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
      };
      // Same rule as the approval notice: a typed answer during a run is
      // delivered into the run when the host offers a live transport, and
      // otherwise waits in the follow-up queue instead of cancelling the run.
      setSubmitted(true);
      submitDecisionOrQueue({
        append: sendNow,
        deliverLive,
        identityKey: getToolActionIdentityKey(request),
        isRunning,
        message,
        text: summary,
        threadKey,
      }).then(
        (outcome) => {
          if (outcome === 'queued') {
            setSubmitted(false);
          }
        },
        (error: unknown) => {
          setSubmitted(false);
          logger.warn('Failed to deliver tool resume action', {
            error,
            runId: request.runId,
            toolCallId: request.toolCallId,
          });
        }
      );
    },
    [aui, deliverLive, isRunning, locked, request, threadKey]
  );

  return { locked, submit };
}

function NoticeShell({
  children,
  icon,
  role,
  testId,
  title,
  tone = 'pending',
}: {
  children: ReactNode;
  icon: ReactNode;
  role?: 'alert';
  testId: string;
  title: string;
  tone?: 'pending' | 'failed';
}) {
  const failed = tone === 'failed';
  return (
    <div
      className={
        failed
          ? 'my-2 rounded-lg border border-destructive/50 bg-destructive/5'
          : 'my-2 rounded-lg border border-sky-500/40 bg-sky-50/50 dark:bg-sky-950/20'
      }
      data-testid={testId}
      role={role}
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 px-4 py-3">
        <div
          aria-hidden="true"
          className={failed ? 'pt-0.5 text-destructive' : 'pt-0.5 text-sky-700 dark:text-sky-400'}
        >
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

function UnreadableSuspendPayloadNotice({
  children,
  detail,
  request,
  testId,
  title,
}: {
  children?: ReactNode;
  detail: string;
  request: AssistantToolSuspendRequest;
  testId: string;
  title: string;
}) {
  const pauseKey = `${request.runId}:${request.toolCallId}:${request.toolName}`;
  const payloadDetail = useMemo(
    () => serializeSuspendPayloadDiagnostic(request.suspendPayload),
    [request.suspendPayload]
  );
  useEffect(() => {
    if (!rememberUnreadablePauseLogIdentity(pauseKey)) {
      return;
    }
    logger.warn('Unreadable tool suspension payload', {
      runId: request.runId,
      suspendPayload: payloadDetail,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
    });
  }, [pauseKey, payloadDetail, request.runId, request.toolCallId, request.toolName]);

  return (
    <NoticeShell
      icon={<TriangleAlert className="size-4" />}
      role="alert"
      testId={testId}
      title={title}
      tone="failed"
    >
      <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
      <p className="mt-1 text-muted-foreground text-xs">{detail}</p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
        {payloadDetail}
      </pre>
      {children}
    </NoticeShell>
  );
}

function SubmitPlanNotice({ request }: { request: AssistantToolSuspendRequest }) {
  const { submit, locked } = useSuspendResume(request);
  const exitPlanMode = usePlanModeExit();
  const [feedback, setFeedback] = useState('');
  const plan = readSubmitPlanPayload(request.suspendPayload);

  const approve = useCallback(() => {
    // Exit plan mode BEFORE composing the resume request so the rebuilt server
    // runtime unlocks the mutation tools for the approved plan. Reject keeps
    // plan mode on (handled by NOT calling this on the reject path). Forwarded
    // child plans have no authority to change the root's mode.
    if (!request.delegation) {
      exitPlanMode?.();
    }
    submit(
      feedback.trim() ? { action: 'approved', feedback: feedback.trim() } : { action: 'approved' },
      'Approved the plan.'
    );
  }, [exitPlanMode, feedback, request.delegation, submit]);

  if (plan === null) {
    return (
      <UnreadableSuspendPayloadNotice
        detail="The suspended request contains unreadable plan terms, so it cannot be approved. You can safely reject it so the assistant can revise."
        request={request}
        testId="assistant-submit-plan-payload-unreadable"
        title="Plan details could not be read"
      >
        <div className="mt-2">
          <Button
            disabled={locked}
            onClick={() => submit({ action: 'rejected' }, 'Rejected the unreadable plan.')}
            size="sm"
            variant="outline"
          >
            <X className="size-3.5" />
            Reject
          </Button>
        </div>
      </UnreadableSuspendPayloadNotice>
    );
  }

  return (
    <NoticeShell
      icon={<ListChecks className="size-4" />}
      testId="assistant-submit-plan-notice"
      title={plan?.title ? `Plan: ${plan.title}` : 'Plan for your approval'}
    >
      <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
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
  // Answers resume through the {answer} OBJECT envelope (AskUserResumeData),
  // never the legacy bare string/array: the 1.56+ suspend-resume transport can
  // only attach the `approved: true` rider to plain-object payloads, and a
  // bare answer to an ask-gated askUser would be denied by Mastra.
  const submitAnswer = useCallback(
    (answer: AskUserResumeData['answer'], summary: string) =>
      submit({ answer } satisfies AskUserResumeData, summary),
    [submit]
  );
  const [freeText, setFreeText] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const payload = readAskUserPayload(request.suspendPayload);
  const readableQuestion = payload === null ? readAskUserQuestion(request.suspendPayload) : null;
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

  if (payload === null) {
    return (
      <UnreadableSuspendPayloadNotice
        detail={
          readableQuestion
            ? 'The question is readable, but its choice controls are not. Answer in your own words or stop the run.'
            : 'The suspended request contains malformed question details, so it cannot be answered here.'
        }
        request={request}
        testId="assistant-ask-user-payload-unreadable"
        title="Question details could not be read"
      >
        {readableQuestion ? (
          <div className="mt-2 space-y-2">
            <p className="text-foreground/90 text-xs">{readableQuestion}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Answer in your own words"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                disabled={locked}
                onChange={(event) => setFreeText(event.target.value)}
                placeholder="Type your answer…"
                value={freeText}
              />
              <Button
                disabled={locked || freeText.trim().length === 0}
                onClick={() => submitAnswer(freeText.trim(), `Answered: ${freeText.trim()}`)}
                size="sm"
                variant="default"
              >
                Send answer
              </Button>
            </div>
          </div>
        ) : null}
      </UnreadableSuspendPayloadNotice>
    );
  }

  return (
    <NoticeShell
      icon={<MessageCircleQuestion className="size-4" />}
      testId="assistant-ask-user-notice"
      title={payload?.question ?? 'The assistant has a question'}
    >
      <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
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
            onClick={() => submitAnswer(freeText.trim(), `Answered: ${freeText.trim()}`)}
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
              submitAnswer(answers, `Answered: ${answers.join(', ')}`);
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
              onClick={() => submitAnswer(option.label, `Answered: ${option.label}`)}
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

/**
 * Dead-end rejection for a suspending tool with NO registered typed resume UI
 * (`hasRegisteredSuspendResumeUi`). We still refuse to guess a typed action
 * (no-silent-wrong-render), but the pause is presented as what it is: something
 * this build cannot answer, not a card that is still waiting for input. The
 * agent stream mapper records the matching durable `tool.resume.unsupported` run
 * event (never `tool.failed` — no tool ran and none failed) and
 * deliberately does NOT terminate the run (the Mastra snapshot is already
 * persisted and stays resumable by a build that registers the tool), so the copy
 * claims nothing about server-side state — it must stay true both on that path
 * and on the version-skew path where an older client renders a newer tool's
 * pause. Dismiss clears the card so the user is not stranded staring at it.
 */
function UnsupportedSuspendNotice({ request }: { request: AssistantToolSuspendRequest }) {
  const [dismissed, setDismissed] = useState(false);
  const detail = useMemo(
    () => serializeSuspendPayloadDiagnostic(request.suspendPayload),
    [request.suspendPayload]
  );
  if (dismissed) {
    return null;
  }
  return (
    <NoticeShell
      icon={<TriangleAlert className="size-4" />}
      role="alert"
      testId="assistant-tool-suspend-unsupported-notice"
      title={`Cannot resume ${request.toolName}`}
      tone="failed"
    >
      <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
      <p className="mt-1 text-muted-foreground text-xs">
        This tool paused the run for input, but this build has no resume UI registered for its
        resume schema, so the pause cannot be answered and the run cannot continue here.
      </p>
      <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
        {detail}
      </pre>
      <div className="mt-2">
        <Button onClick={() => setDismissed(true)} size="sm" variant="outline">
          Dismiss
        </Button>
      </div>
    </NoticeShell>
  );
}

/**
 * Gate B (BST-1070 design §3.3): the `run_python` network escalation. A
 * DIFFERENT component from the approval card on purpose — destructive chrome,
 * inverted button order with DENY primary and autofocused, a per-domain
 * checkbox the affirmative action requires, and NO grant surface at all (this
 * component never renders ApprovalGrantButtons and never reads
 * useToolApprovalGrants — a grant would let one answer authorize a future,
 * unnamed domain list). Deny is the outcome of every non-action.
 */
function narrowNetworkSuspendPayload(value: unknown): readonly string[] | null {
  if (!(isRecord(value) && value['kind'] === 'network')) {
    return null;
  }
  const domains = value['allowedDomains'];
  if (
    !(
      Array.isArray(domains) &&
      domains.length > 0 &&
      domains.every((domain) => typeof domain === 'string' && domain.trim().length > 0)
    )
  ) {
    return null;
  }
  return domains as readonly string[];
}

/** "— any host ending in .example.com" for wildcards; exact hosts need no gloss. */
function wildcardGloss(domain: string): string | null {
  return domain.startsWith('*.') ? `— any host ending in ${domain.slice(1)}` : null;
}

function RunPythonNetworkNotice({ request }: { request: AssistantToolSuspendRequest }) {
  const domainsFieldId = useId();
  const { submit, locked } = useSuspendResume(request);
  // Ticking state is LOCAL component state, never persisted, and resets if
  // the card remounts (design §3.3 point 3) — proportional friction is the
  // point: every named domain must be individually acknowledged.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const domains = narrowNetworkSuspendPayload(request.suspendPayload);
  const payloadDetail = useMemo(
    () => serializeSuspendPayloadDiagnostic(request.suspendPayload),
    [request.suspendPayload]
  );

  const deny = useCallback(() => {
    submit({ action: 'deny' } satisfies { action: 'deny' }, "You didn't allow internet access.");
  }, [submit]);
  const allow = useCallback(() => {
    if (!domains) {
      return;
    }
    submit(
      { action: 'allow' } satisfies { action: 'allow' },
      domains.length === 1 ? `You allowed ${domains[0]}.` : `You allowed ${domains.length} domains.`
    );
  }, [domains, submit]);

  if (!domains) {
    // A registered escalation whose payload cannot be read: never offer Allow
    // for terms the card cannot state — deny stays available, and the raw
    // payload is shown so the degradation is visible, not guessed around.
    return (
      <NoticeShell
        icon={<Globe className="size-4" />}
        testId="assistant-run-python-network-notice"
        title="This script wants to reach the internet"
        tone="failed"
      >
        <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
        <p
          className="mt-1 text-muted-foreground text-xs"
          data-testid="run-python-network-unreadable"
        >
          The request didn't say which domains it needs, so it can't be allowed.
        </p>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
          {payloadDetail}
        </pre>
        <div className="mt-2">
          <Button autoFocus disabled={locked} onClick={deny} size="sm" variant="default">
            <X className="size-3.5" />
            Don't allow
          </Button>
        </div>
      </NoticeShell>
    );
  }

  const allTicked = domains.every((domain) => ticked.has(domain));
  const allowLabel =
    domains.length === 1 ? `Allow ${domains[0]}` : `Allow these ${domains.length} domains`;

  return (
    <NoticeShell
      icon={<Globe className="size-4" />}
      testId="assistant-run-python-network-notice"
      title="This script wants to reach the internet"
      tone="failed"
    >
      <RediscoveredPauseLines display={readRediscoveredPauseDisplay(request)} />
      <p className="mt-1 text-foreground/90 text-xs">
        You said the code could run. Before it does, it needs your OK to connect out.
      </p>
      <p className="mt-2 text-muted-foreground text-xs">It will be able to connect to:</p>
      <div
        className="mt-1 max-h-48 space-y-1.5 overflow-auto"
        data-testid="run-python-network-domains"
      >
        {domains.map((domain) => (
          <div className="flex items-start gap-2 text-xs" key={domain}>
            <Checkbox
              checked={ticked.has(domain)}
              data-testid={`run-python-network-domain-${domain}`}
              disabled={locked}
              id={`${domainsFieldId}-${domain}`}
              onCheckedChange={(checked) => {
                setTicked((current) => {
                  const next = new Set(current);
                  if (checked === true) {
                    next.add(domain);
                  } else {
                    next.delete(domain);
                  }
                  return next;
                });
              }}
            />
            <label className="min-w-0" htmlFor={`${domainsFieldId}-${domain}`}>
              {/* Never truncate a domain with an ellipsis: pypi.org.evil.com
                  clipped to pypi.org… is a lie. */}
              <span className="break-all font-mono text-foreground/90">{domain}</span>
              {wildcardGloss(domain) ? (
                <span className="ml-1 text-muted-foreground">{wildcardGloss(domain)}</span>
              ) : null}
            </label>
          </div>
        ))}
      </div>
      <p className="mt-2 text-muted-foreground text-xs">
        Nothing else. Every other address is blocked.
      </p>
      <p className="mt-1 text-foreground/90 text-xs">
        Once it can connect, it can also send data out — including anything it read from your files.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Deny is FIRST in DOM and tab order, primary, and autofocused: a
            user clicking where Approve usually sits denies; Enter denies. */}
        <Button
          autoFocus
          data-testid="run-python-network-deny"
          disabled={locked}
          onClick={deny}
          size="sm"
          variant="default"
        >
          <X className="size-3.5" />
          Don't allow
        </Button>
        <Button
          data-testid="run-python-network-allow"
          disabled={locked || !allTicked}
          onClick={allow}
          size="sm"
          variant="outline"
        >
          <Check className="size-3.5" />
          {allowLabel}
        </Button>
        {allTicked || locked ? null : (
          <span className="text-muted-foreground text-xs">
            Tick each domain above to enable this.
          </span>
        )}
      </div>
      <p className="mt-2 text-muted-foreground text-xs">
        You'll be asked this every time. There is no "always allow" for internet access.
      </p>
    </NoticeShell>
  );
}

/**
 * The typed suspension UI per REGISTERED suspending tool. Typing it as a total
 * `Record<RegisteredSuspendResumeToolId, …>` makes the contract registry and the
 * rendered branches provably exhaustive at compile time: adding an id to
 * `REGISTERED_SUSPEND_RESUME_TOOL_IDS` without a branch here is a type error,
 * which is the drift that would otherwise re-create the silent dead end.
 */
const SUSPEND_NOTICE_BY_TOOL_ID: Record<
  RegisteredSuspendResumeToolId,
  (props: { request: AssistantToolSuspendRequest }) => ReactNode
> = {
  [ASK_USER_TOOL_ID]: AskUserNotice,
  [NATIVE_TOOL_ID.runPython]: RunPythonNetworkNotice,
  [SUBMIT_PLAN_TOOL_ID]: SubmitPlanNotice,
};

export function AssistantToolSuspendNotice({ data }: AssistantToolSuspendNoticeProps) {
  const request = isAssistantToolSuspendRequest(data) ? data : null;
  if (!request) {
    return null;
  }
  if (hasRegisteredSuspendResumeUi(request.toolName)) {
    const RegisteredNotice = SUSPEND_NOTICE_BY_TOOL_ID[request.toolName];
    return <RegisteredNotice key={getToolActionIdentityKey(request)} request={request} />;
  }
  // Unknown suspending tool: never guess a typed action (no-silent-wrong-render)
  // AND never present it as still-actionable — surface the rejection.
  return <UnsupportedSuspendNotice request={request} />;
}

AssistantToolSuspendNotice.displayName = 'AssistantToolSuspendNotice';
