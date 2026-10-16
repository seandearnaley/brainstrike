import { createLogger } from '@brainstrike/logging';
import { generateText } from 'ai';
import type { HostRunState } from './core-state.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';

const logger = createLogger('AgentHost');

type Updated = Extract<HostEvent, { type: 'thread.updated' }>;
type Outcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];
/** A thread's committed presentation: its title, colour and icon. */
export type HostThreadPresentation = Omit<Updated, 'type'>;

/** The system instructions of a host thread title request (one per untitled thread). */
export const HOST_THREAD_TITLE_INSTRUCTIONS =
  "Write a short title, at most eight words, for a conversation that starts with the user's message. Reply with the title only: no quotes and no trailing punctuation.";

/**
 * The bound on one thread title request. A title is a single short
 * non-streaming completion (at most eight words); measured OpenRouter titles
 * took 4.3 to 6.7 s. Fifteen seconds is over twice the slowest of those, and
 * it caps how long a silent provider can hold a completed or stopped run's
 * retirement, which joins the title before the run's admission closes.
 */
export const HOST_THREAD_TITLE_TIMEOUT_MS = 15_000;

/** The model's first line, without wrapping quotes; empty output is no title. */
function normalizeTitle(text: string): string | undefined {
  const line = text.trim().split('\n')[0] ?? '';
  const title = line
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, 120);
  return title || undefined;
}

/** One run's outstanding title request. */
interface PendingTitle {
  /** Settles once the request answers, fails, or its signal aborts; never rejects. */
  readonly title: Promise<string | undefined>;
  /** Withdraws the request when its run can never commit a title. */
  readonly withdraw: AbortController;
}

/** The thread catalog's committed presentation, folded from Core's own log; owns no writer. */
export class HostThreadPresentationState {
  private readonly presentations = new Map<string, HostThreadPresentation>();
  private readonly pending = new Map<string, PendingTitle>();

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
   * Once an admitted run's prompt passes its hooks to its model (and at a
   * completed finish, for a run recovered after a restart): a run of an
   * untitled thread with no completed run asks its own model for a title,
   * beside its answer. The title depends only on the user's message. The
   * request aborts on the run's signal (a Stop or a host close), on `withdraw`,
   * or after `HOST_THREAD_TITLE_TIMEOUT_MS`, and it settles when its signal
   * aborts even if the provider ignores that signal: the run's admission joins
   * it (`join`) before closing, so it must always end. Idempotent per run.
   */
  request(run: HostRunState, runs: Iterable<HostRunState>): void {
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
      return;
    }
    const withdraw = new AbortController();
    const expiry = new AbortController();
    const timer = setTimeout(() => {
      expiry.abort(
        new DOMException(
          `The thread title request exceeded ${HOST_THREAD_TITLE_TIMEOUT_MS} ms`,
          'TimeoutError'
        )
      );
    }, HOST_THREAD_TITLE_TIMEOUT_MS);
    const signal = AbortSignal.any([run.controller.signal, withdraw.signal, expiry.signal]);
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const generated = generateText({
      abortSignal: signal,
      maxRetries: 0,
      model: admission.model,
      prompt: run.branch.prompt,
      system: HOST_THREAD_TITLE_INSTRUCTIONS,
    });
    const title = Promise.race([generated, aborted])
      .then(
        (result) => normalizeTitle(result.text),
        (cause: unknown): undefined => {
          // A Stop, a host close or a withdrawal ends the title on purpose;
          // a provider failure or an expired bound is reported.
          if (!(run.controller.signal.aborted || withdraw.signal.aborted)) {
            logger.warn('Host thread title request failed', {
              code: 'host_thread_title_failed',
              errorName: cause instanceof Error ? cause.name : typeof cause,
              runId: run.id,
              threadId: run.threadId,
              ...(expiry.signal.aborted ? { timeoutMs: HOST_THREAD_TITLE_TIMEOUT_MS } : {}),
            });
          }
          return;
        }
      )
      .finally(() => clearTimeout(timer));
    this.pending.set(run.id, { title, withdraw });
  }

  /**
   * As a run finishes, before its admission closes: a completed run asks
   * (idempotent; a run recovered after a restart never passed admission), and
   * a run that can never commit a title (failed or interrupted) withdraws its
   * request, so its retirement never waits on the title.
   */
  finishing(run: HostRunState, outcome: Outcome, runs: Iterable<HostRunState>): void {
    if (outcome === 'completed') {
      this.request(run, runs);
      return;
    }
    if (outcome === 'failed' || outcome === 'interrupted') {
      this.pending
        .get(run.id)
        ?.withdraw.abort(new Error('The run can no longer commit its thread title'));
    }
  }

  /** The run's title request, which its admission joins before it closes; never rejects. */
  async join(run: HostRunState): Promise<void> {
    await this.pending.get(run.id)?.title;
  }

  /**
   * After a run finishes: a completed or stopped run commits its title unless
   * a rename came first (a Stop does not withdraw the user's message). A failed
   * or interrupted run commits none.
   */
  settle(run: HostRunState): void {
    const title = this.pending.get(run.id)?.title;
    this.pending.delete(run.id);
    if (!title || (run.outcome !== 'completed' && run.outcome !== 'stopped')) {
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
