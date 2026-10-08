import { randomUUID } from 'node:crypto';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { LanguageModel } from 'ai';
import {
  deriveHostChildAdmission,
  type HostChildResult,
  HostDelegationInputSchema,
  hostChildResult,
} from './child-runs.js';
import type { HostRunState } from './core-state.js';
import type { HostRunAdmission } from './ports.js';
import type { HostChildOrigin, HostEvent, HostLogRow } from './protocol.js';
import { delegatedHostRunAdmission, startedHostRun } from './run-branch.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Started = Extract<HostEvent, { type: 'run.started' }>;

/** HostCore's writer, loop and stop, lent to one delegation. */
export interface HostChildRunPort {
  /** Commit `items` in one transaction, then register the child thread and run. */
  commit(prepared: HostPreparedChild): Promise<void>;
  loop(child: HostRunState, model: LanguageModel): Promise<void>;
  retainRun(): () => void;
  stop(child: HostRunState, reason: unknown): void;
  /** Whether an ID is already a committed thread or conversation identity. */
  taken(id: string): boolean;
}

export interface HostDelegationRequest {
  readonly action: Action;
  readonly admission: HostRunAdmission;
  readonly input: unknown;
  readonly persona: AssistantPersonaDefinition;
  readonly run: HostRunState;
}

/** A delegation's child, prepared but not yet committed. */
export interface HostPreparedChild {
  readonly child: HostRunState;
  /** The parent's effect and the child's origin and first run: one transaction. */
  readonly items: readonly { readonly event: HostEvent; readonly threadId: string }[];
  readonly model: LanguageModel;
  readonly origin: HostChildOrigin;
  readonly persona: AssistantPersonaDefinition;
  readonly settled: Promise<void>;
  readonly threadId: string;
}

/**
 * BST-1932: HostCore's child-thread registry, folded from the committed log.
 * HostCore remains the only writer; this owns no store, queue or loop.
 */
export class HostChildRuns {
  private readonly origins = new Map<string, HostChildOrigin>();
  private readonly settlements = new Map<string, PromiseWithResolvers<void>>();

  isChild(threadId: string): boolean {
    return this.origins.has(threadId);
  }

  /** `threadId` and every descendant child thread, deepest first. */
  subtree(threadId: string): string[] {
    const children = [...this.origins]
      .filter(([, origin]) => origin.parentThreadId === threadId)
      .flatMap(([child]) => this.subtree(child));
    return [...children, threadId];
  }

  forget(threadId: string): void {
    this.origins.delete(threadId);
  }

  /** Folds after HostCore's own fold, so a started run already exists. */
  fold(row: HostLogRow, runs: ReadonlyMap<string, HostRunState>): void {
    const event = row.event;
    if (event.type === 'thread.started' && 'origin' in event) {
      this.origins.set(row.threadId, event.origin);
    } else if (event.type === 'run.started') {
      const run = runs.get(event.runId);
      const origin = this.origins.get(row.threadId);
      if (run && origin) {
        run.origin = origin;
      }
    } else if (event.type === 'run.finished') {
      this.settlements.get(event.runId)?.resolve();
      this.settlements.delete(event.runId);
    }
  }

  /**
   * A foreground persona delegation. The child thread's origin and first run
   * commit with the parent's effect in one transaction; the child runs its
   * own loop and abort control, and only its result returns to the parent.
   */
  async delegate(request: HostDelegationRequest, port: HostChildRunPort): Promise<HostChildResult> {
    const prepared = this.prepare(request, port.taken);
    const release = port.retainRun();
    prepared.child.release = release;
    try {
      await port.commit(prepared);
    } catch (cause) {
      this.settlements.delete(prepared.child.id);
      release();
      throw cause;
    }
    request.run.started.add(request.action.toolCallId);
    this.origins.set(prepared.threadId, prepared.origin);
    return this.join(
      prepared,
      request.run.controller.signal,
      () => port.loop(prepared.child, prepared.model),
      (reason) => port.stop(prepared.child, reason)
    );
  }

  /** The child's identity, its admission narrowed from the parent's, and its committed rows. */
  private prepare(
    { action, admission, input, persona, run }: HostDelegationRequest,
    taken: (id: string) => boolean
  ): HostPreparedChild {
    const delegation = admission.delegation;
    if (!delegation) {
      throw new Error('Run has no admitted delegation capability');
    }
    if (persona.model) {
      throw new Error(`Persona "${persona.id}" pins a model, which host threads cannot run yet`);
    }
    const { prompt } = HostDelegationInputSchema.parse(input);
    const origin: HostChildOrigin = {
      background: false,
      depth: (run.origin?.depth ?? 0) + 1,
      parentRunId: run.id,
      parentThreadId: run.threadId,
      persona: persona.id,
      toolCallId: action.toolCallId,
      turnId: run.origin?.turnId ?? run.id,
    };
    const childAdmission = deriveHostChildAdmission(admission, persona, delegation.settings);
    const threadId = randomUUID();
    const started: Started = {
      modelId: run.modelId,
      parentMessageId: null,
      prompt,
      runId: randomUUID(),
      snapshot: childAdmission.snapshot,
      type: 'run.started',
    };
    if (taken(threadId) || taken(started.runId)) {
      throw new Error('Generated child identity collides with a committed identity');
    }
    const child = startedHostRun(
      [],
      threadId,
      started,
      delegatedHostRunAdmission(threadId),
      childAdmission.snapshot
    );
    child.origin = origin;
    child.admission = childAdmission;
    const settled = Promise.withResolvers<void>();
    this.settlements.set(child.id, settled);
    return {
      child,
      items: [
        { event: action, threadId: run.threadId },
        { event: { origin, type: 'thread.started' }, threadId },
        { event: started, threadId },
      ],
      model: childAdmission.model,
      origin,
      persona,
      settled: settled.promise,
      threadId,
    };
  }

  /**
   * Runs a foreground child to its committed terminal. The parent's abort
   * stops the child (report section 4) and ends this wait; the child's own
   * abort control stays separate, so siblings never share it.
   */
  private async join(
    prepared: HostPreparedChild,
    parent: AbortSignal,
    start: () => Promise<void>,
    stop: (reason: unknown) => void
  ): Promise<HostChildResult> {
    const { child } = prepared;
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const stopChild = (): void => {
      aborted.reject(parent.reason);
      stop(parent.reason);
    };
    parent.addEventListener('abort', stopChild, { once: true });
    child.task = start();
    child.task.catch(() => undefined);
    if (parent.aborted) {
      stopChild();
    }
    try {
      await Promise.race([prepared.settled, aborted.promise]);
    } finally {
      parent.removeEventListener('abort', stopChild);
    }
    if (!child.outcome) {
      throw new Error('Child run settled without a committed outcome');
    }
    return hostChildResult(prepared.threadId, prepared.persona, child.outcome, child.messages);
  }
}
