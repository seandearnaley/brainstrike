import { ProviderRequestContextOverflowError } from '@brainstrike/agent/provider-request';
import {
  describeEmptyModelResponse,
  describeStreamStall,
  describeToolCallInputTimeout,
  extractProviderRunError,
  getAbnormalFinishMessage,
  isContextOverflowProviderErrorCode,
  outputLimitContextFor,
  type RuntimeData,
  resolveProviderError,
  StreamStalledError,
  ToolCallInputStreamingTimeoutError,
} from '@brainstrike/agent/provider-runtime';
import {
  APICallError,
  type FinishReason,
  StreamProviderError,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import type { HostEvent } from './protocol.js';

/** Finish reasons that complete a run. Every other reason is a visible failure. */
const COMPLETED_FINISH_REASONS: ReadonlySet<FinishReason> = new Set(['stop', 'tool-calls']);
/** An error finish always fails, even when no error part carried a message. */
const ERROR_FINISH_DETAIL = 'Assistant run failed.';
const NON_WHITESPACE = /\S/u;

type HostRunAttempt = Extract<HostEvent, { type: 'run.attempt' }>;
/** How one attempt failed, when that failure class may be re-attempted. */
export type HostAttemptFailure = Pick<HostRunAttempt, 'detail' | 'reason' | 'refusal' | 'stall'>;

/**
 * The request did not fit: the host's own measured budget refused it, or the
 * provider reported a context overflow. Core recovers it only by compacting.
 */
function isContextOverflow(cause: unknown): boolean {
  return (
    cause instanceof ProviderRequestContextOverflowError ||
    isContextOverflowProviderErrorCode(extractProviderRunError(cause).code)
  );
}

/** A provider-classified transient failure; typed host refusals are never retryable. */
function isRetryableProviderError(cause: unknown): boolean {
  return (
    (APICallError.isInstance(cause) || StreamProviderError.isInstance(cause)) &&
    cause.isRetryable === true
  );
}

/**
 * The terminal truth of one SDK attempt, read from the same stream parts Core
 * commits. Provider errors, abnormal finish reasons and an empty reply become
 * the visible `run.finished` detail; the copy is shared with the legacy path.
 */
export class HostRunOutcome {
  private cause: unknown;
  private contributed: boolean;
  private failure: string | undefined;
  private finishReason: FinishReason | undefined;
  /** The step not yet committed as `model.step` emitted tool input or a call. */
  private openStepTools = false;
  /** The step not yet committed as `model.step` emitted model output. */
  private openStepOutput = false;
  /** A step that ended in a provider error was committed with its partial content. */
  private committedErrorStep: 'tool-parts' | 'committed-output' | undefined;

  /**
   * @param resumed - The run leg began with committed model steps (an approval
   *   or restart continuation), so the model has contributed to it.
   */
  constructor(
    private readonly configuration: Readonly<RuntimeData> | undefined,
    private readonly modelId: string,
    resumed: boolean
  ) {
    this.contributed = resumed;
  }

  observe(chunk: TextStreamPart<ToolSet>): void {
    switch (chunk.type) {
      case 'error':
        this.fail(chunk.error);
        return;
      case 'finish':
        this.finishReason = chunk.finishReason;
        return;
      case 'text-delta':
      case 'reasoning-delta':
        this.contributed ||= NON_WHITESPACE.test(chunk.text);
        this.openStepOutput ||= chunk.text.length > 0;
        return;
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-call':
        this.contributed = true;
        this.openStepOutput = true;
        this.openStepTools = true;
        return;
      case 'file':
      case 'source':
        this.contributed = true;
        this.openStepOutput = true;
        return;
      case 'tool-result':
      case 'tool-error':
      case 'tool-approval-request':
      case 'tool-output-denied':
        this.contributed = true;
        return;
      default:
        return;
    }
  }

  /**
   * Core committed the open step's `model.step`; a new step opens. The SDK
   * also records a step that ended in a provider error, with whatever partial
   * content it produced, so that content is now part of the transcript.
   */
  stepCommitted(step: {
    readonly content: readonly { readonly type: string }[];
    readonly finishReason: FinishReason;
  }): void {
    if (step.finishReason === 'error' && step.content.length > 0) {
      this.committedErrorStep = step.content.some((part) => part.type === 'tool-call')
        ? 'tool-parts'
        : 'committed-output';
    }
    this.openStepOutput = false;
    this.openStepTools = false;
  }

  /**
   * A watchdog expiry, provider or local error, classified once at this choke
   * point (a provider 401 carries its remedy). The host runs no tool-lifecycle
   * hooks, so a tool-executing stall never names them.
   */
  fail(cause: unknown): void {
    this.cause = cause;
    this.failure =
      cause instanceof StreamStalledError
        ? describeStreamStall(cause, {
            model: this.configuration?.model ?? this.modelId,
            provider: this.configuration?.provider,
            toolHooks: false,
          })
        : cause instanceof ToolCallInputStreamingTimeoutError
          ? describeToolCallInputTimeout(cause)
          : resolveProviderError(cause, this.configuration).detail;
  }

  private emptyReply(): boolean {
    return (
      this.failure === undefined &&
      this.finishReason !== undefined &&
      COMPLETED_FINISH_REASONS.has(this.finishReason) &&
      !this.contributed
    );
  }

  /** The visible failure detail, or undefined when the attempt completed truthfully. */
  detail(): string | undefined {
    if (this.failure !== undefined || this.finishReason === undefined) {
      return this.failure;
    }
    if (!COMPLETED_FINISH_REASONS.has(this.finishReason)) {
      return (
        getAbnormalFinishMessage(this.finishReason, outputLimitContextFor(this.configuration)) ??
        ERROR_FINISH_DETAIL
      );
    }
    if (!this.contributed) {
      return describeEmptyModelResponse(
        this.configuration?.model ?? this.modelId,
        this.finishReason
      );
    }
    return undefined;
  }

  /**
   * The attempt's failure when its class may be re-attempted: a stall, a
   * retryable provider error, or an empty reply. `refusal` marks one that must
   * not be: the open step streamed tool input or a call (re-running it could
   * execute a tool again), or a provider error's step already committed output.
   */
  attemptFailure(): HostAttemptFailure | undefined {
    const detail = this.detail();
    if (detail === undefined) {
      return;
    }
    if (this.cause instanceof StreamStalledError) {
      return {
        detail,
        reason: 'stalled',
        ...(this.openStepTools ? { refusal: 'tool-parts' as const } : {}),
        stall: {
          ...(this.cause.lastPartType ? { lastPartType: this.cause.lastPartType } : {}),
          partsSeen: this.cause.partsSeen,
          phase: this.cause.phase,
        },
      };
    }
    const reason = isContextOverflow(this.cause)
      ? ('context-overflow' as const)
      : isRetryableProviderError(this.cause)
        ? ('provider-error' as const)
        : undefined;
    if (reason) {
      const refusal = this.openStepTools
        ? ('tool-parts' as const)
        : (this.committedErrorStep ??
          (this.openStepOutput ? ('committed-output' as const) : undefined));
      return { detail, reason, ...(refusal ? { refusal } : {}) };
    }
    return this.emptyReply() ? { detail, reason: 'empty-response' } : undefined;
  }
}
