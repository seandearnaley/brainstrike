import {
  describeEmptyModelResponse,
  describeStreamStall,
  describeToolCallInputTimeout,
  getAbnormalFinishMessage,
  outputLimitContextFor,
  type RuntimeData,
  resolveProviderError,
  StreamStalledError,
  ToolCallInputStreamingTimeoutError,
} from '@brainstrike/agent/provider-runtime';
import type { FinishReason, TextStreamPart, ToolSet } from 'ai';

/** Finish reasons that complete a run. Every other reason is a visible failure. */
const COMPLETED_FINISH_REASONS: ReadonlySet<FinishReason> = new Set(['stop', 'tool-calls']);
/** An error finish always fails, even when no error part carried a message. */
const ERROR_FINISH_DETAIL = 'Assistant run failed.';
const NON_WHITESPACE = /\S/u;

/**
 * The terminal truth of one SDK loop, read from the same stream parts Core
 * commits. Provider errors, abnormal finish reasons and an empty reply become
 * the visible `run.finished` detail; the copy is shared with the legacy path.
 */
export class HostRunOutcome {
  private contributed: boolean;
  private failure: string | undefined;
  private finishReason: FinishReason | undefined;

  /**
   * @param resumed - The run already committed model steps (an approval or
   *   restart continuation), so the model has contributed to it.
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
        return;
      case 'file':
      case 'source':
      case 'tool-input-start':
      case 'tool-call':
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
   * A watchdog expiry, provider or local error, classified once at this choke
   * point (a provider 401 carries its remedy). The host runs no tool-lifecycle
   * hooks, so a tool-executing stall never names them.
   */
  fail(cause: unknown): void {
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

  /** The visible failure detail, or undefined when the loop completed truthfully. */
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
}
