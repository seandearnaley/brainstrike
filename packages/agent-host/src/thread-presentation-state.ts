import { createLogger } from '@brainstrike/logging';
import { generateText } from 'ai';
import type { HostRunState } from './core-state.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';

const logger = createLogger('AgentHost');

type Updated = Extract<HostEvent, { type: 'thread.updated' }>;
/** A thread's committed presentation: its title, colour and icon. */
export type HostThreadPresentation = Omit<Updated, 'type'>;

/** The system instructions of a host thread title request (one per untitled thread). */
export const HOST_THREAD_TITLE_INSTRUCTIONS =
  "Write a short title, at most eight words, for a conversation that starts with the user's message. Reply with the title only: no quotes and no trailing punctuation.";

/** The model's first line, without wrapping quotes; empty output is no title. */
function normalizeTitle(text: string): string | undefined {
  const line = text.trim().split('\n')[0] ?? '';
  const title = line
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, 120);
  return title || undefined;
}

/** The thread catalog's committed presentation, folded from Core's own log; owns no writer. */
export class HostThreadPresentationState {
  private readonly presentations = new Map<string, HostThreadPresentation>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly core: {
      /** Core's admission queue: a generated title commits after any queued rename. */
      readonly admit: (threadId: string, perform: () => Promise<void>) => Promise<void>;
      readonly append: (threadId: string, event: Updated) => Promise<void>;
      readonly update: (params: HostParams<'thread/update'>, event: Updated) => Promise<void>;
    }
  ) {}

  fold(row: HostLogRow): void {
    if (row.event.type === 'thread.updated') {
      const { type: _type, ...changed } = row.event;
      this.presentations.set(row.threadId, { ...this.presentations.get(row.threadId), ...changed });
    }
  }

  forget(threadId: string): void {
    this.presentations.delete(threadId);
  }

  /** Fields never committed are absent; the client shows its defaults. */
  read(threadId: string): HostThreadPresentation {
    return { ...this.presentations.get(threadId) };
  }

  private titled(threadId: string): boolean {
    return this.presentations.get(threadId)?.title !== undefined;
  }

  async update(params: HostParams<'thread/update'>): Promise<{ accepted: true }> {
    const { commandId: _commandId, threadId: _threadId, ...changed } = params;
    await this.core.update(params, { ...changed, type: 'thread.updated' });
    return { accepted: true };
  }

  /**
   * At a completed finish, before the run closes its admission: the first
   * completed run of an untitled thread asks its own model for a title. The
   * run joins the returned promise, which never rejects, before it closes.
   * A failed, stopped or interrupted run never asks.
   */
  request(run: HostRunState, runs: Iterable<HostRunState>): Promise<void> {
    const admission = run.admission;
    if (
      !admission?.generatesThreadTitle ||
      run.terminal ||
      run.stopped ||
      run.controller.signal.aborted ||
      (run.mcpInputPersistenceFailures?.length ?? 0) > 0 ||
      this.pending.has(run.id) ||
      this.titled(run.threadId) ||
      [...runs].some(
        (other) => other !== run && other.threadId === run.threadId && other.outcome === 'completed'
      )
    ) {
      return Promise.resolve();
    }
    const title = generateText({
      abortSignal: run.controller.signal,
      maxRetries: 0,
      model: admission.model,
      prompt: run.branch.prompt,
      system: HOST_THREAD_TITLE_INSTRUCTIONS,
    }).then(
      (result) => normalizeTitle(result.text),
      (cause: unknown): undefined => {
        if (!run.controller.signal.aborted) {
          logger.warn('Host thread title request failed', {
            code: 'host_thread_title_failed',
            errorName: cause instanceof Error ? cause.name : typeof cause,
            runId: run.id,
            threadId: run.threadId,
          });
        }
        return;
      }
    );
    this.pending.set(run.id, title);
    return title.then(() => undefined);
  }

  /** After a run finishes: a completed run commits its title unless a rename came first. */
  settle(run: HostRunState): void {
    const title = this.pending.get(run.id);
    this.pending.delete(run.id);
    if (!title || run.outcome !== 'completed') {
      return;
    }
    void title
      .then(async (generated) => {
        if (!generated) {
          return;
        }
        await this.core.admit(run.threadId, async () => {
          if (!this.titled(run.threadId)) {
            await this.core.append(run.threadId, { title: generated, type: 'thread.updated' });
          }
        });
      })
      .catch((cause: unknown) => {
        logger.warn('Host thread title was not committed', {
          code: 'host_thread_title_not_committed',
          errorName: cause instanceof Error ? cause.name : typeof cause,
          runId: run.id,
          threadId: run.threadId,
        });
      });
  }
}
