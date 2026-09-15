import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import type { BackgroundTask } from '@mastra/core/background-tasks';

/**
 * The leg-scoped seam through which a decision reaches a RUNNING leg
 * (settled 2026-09-14, canonical after Claude Code's in-session subagent
 * prompts and Codex's cross-thread approval overlay).
 *
 * A decision used to start a NEW host leg and, while a leg was running, wait
 * in the renderer's follow-up queue for it to settle — a parked specialist
 * stayed parked until every sibling returned and the parent's continuation
 * finished. Now the host delivers the decision into the live leg: whichever
 * background phase currently owns the leg's stream (the idle loop, or the
 * resume stream's terminal wait) registers itself here as the owner; the
 * leg's handler validates and records the decision, and the owner resumes
 * the parked task in-process and publishes the host's answer chunk on the
 * same stream. Without an owner, or before the leg armed its handler, the
 * decision is refused as NOT live ({@link LiveDecisionUnavailableError}) and
 * the caller takes the ordinary new-leg path — a refusal, never a silent
 * queue on the host.
 *
 * This module carries no runtime dependencies so `agent-runtime.ts` can own
 * one channel per runtime without an import cycle; the handler itself is
 * built by `live-decisions.ts` from the leg.
 */

/** One parked task and the decision that resumes it. */
export interface LiveBackgroundResume {
  readonly resumeData: unknown;
  readonly task: BackgroundTask;
}

/** A phase's hold on parked tasks it agreed to resume; the phase cannot settle until each is resumed or released. */
export interface LiveBackgroundReservation {
  /** Give the tasks back unresumed (a host record failed before any native effect). */
  release(): void;
  /** Resume every reserved task in-process; a task whose resume fails is released. */
  resume(resumes: readonly LiveBackgroundResume[]): Promise<void>;
}

/** The background phase currently driving the leg's stream. */
export interface LiveBackgroundOwner {
  /** Enqueue a host chunk on the leg's stream; `false` once it closed. */
  publish(chunk: unknown): boolean;
  /**
   * Reserve parked tasks for an in-process resume, synchronously, before any
   * durable record is written: the phase keeps running until the reservation
   * is resumed or released. Throws {@link LiveDecisionUnavailableError} once
   * the phase no longer accepts work.
   */
  reserve(tasks: readonly BackgroundTask[]): LiveBackgroundReservation;
}

export interface LiveDecisionRequest {
  /** A canonical approval or typed-resume action addressed to a parked child. */
  readonly action: LiveDecisionAction;
  /**
   * The request's TRUSTED permission snapshot (`resolveRequestPermissionPolicy`),
   * carrying any lasting grant the user recorded with this decision.
   */
  readonly permissionPolicy?: PermissionToolGateSnapshot | undefined;
}

export type LiveDecisionAction = AssistantToolApprovalAction | AssistantToolResumeAction;

/** What a leg arms on its channel: decisions in, parked tasks observed. */
export interface LiveDecisionHandler {
  deliver(request: LiveDecisionRequest): Promise<void>;
  /**
   * A task parked under the owning phase. Resolves once any answer a
   * remembered grant gives it has been delivered (or refused); the phase
   * waits for it before settling on that pause.
   */
  suspended(taskId: string): Promise<void>;
}

/** The decision cannot be applied live; the ordinary new-leg path applies. */
export class LiveDecisionUnavailableError extends Error {
  override readonly name = 'LiveDecisionUnavailableError';
}

export function isLiveDecisionUnavailableError(
  error: unknown
): error is LiveDecisionUnavailableError {
  return error instanceof Error && error.name === 'LiveDecisionUnavailableError';
}

export interface LiveDecisionChannel {
  /** Arm a leg's handler, replacing the previous leg's; the release disarms it. */
  arm(handler: LiveDecisionHandler): () => void;
  /** Deliver a decision to the armed handler; refused when the leg is not live. */
  deliver(request: LiveDecisionRequest): Promise<void>;
  /** Take ownership for a phase; the returned release restores the previous owner. */
  own(owner: LiveBackgroundOwner): () => void;
  /** The phase currently driving the stream, if any. */
  readonly owner: LiveBackgroundOwner | undefined;
  remember(policy: PermissionToolGateSnapshot): void;
  /** The lasting grant a live decision delivered, applied to later pauses. */
  readonly remembered: PermissionToolGateSnapshot | undefined;
  /** Report a parked task (called by the owning phase); see `LiveDecisionHandler.suspended`. */
  suspended(taskId: string): Promise<void>;
}

export function createLiveDecisionChannel(): LiveDecisionChannel {
  let owner: LiveBackgroundOwner | undefined;
  let handler: LiveDecisionHandler | undefined;
  let remembered: PermissionToolGateSnapshot | undefined;
  return {
    arm(next) {
      handler = next;
      return () => {
        if (handler === next) {
          handler = undefined;
        }
      };
    },
    deliver(request) {
      if (!handler) {
        return Promise.reject(
          new LiveDecisionUnavailableError('The leg has not armed a live decision handler.')
        );
      }
      return handler.deliver(request);
    },
    own(next) {
      const previous = owner;
      owner = next;
      return () => {
        if (owner === next) {
          owner = previous;
        }
      };
    },
    get owner() {
      return owner;
    },
    remember(policy) {
      remembered = policy;
    },
    get remembered() {
      return remembered;
    },
    suspended(taskId) {
      return handler ? handler.suspended(taskId) : Promise.resolve();
    },
  };
}
