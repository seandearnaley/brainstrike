import { createLogger } from '@brainstrike/logging';
import { generateText } from 'ai';
import type { HostRunState } from './core-state.js';
import type { HostRunAdmission } from './ports.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';

const logger = createLogger('AgentHost');

type Renamed = Extract<HostEvent, { type: 'thread.renamed' }>;

const TITLE_INSTRUCTIONS =
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

/** The thread catalog's committed titles, folded from Core's own log; owns no writer. */
export class HostThreadTitleState {
  private readonly titles = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly core: {
      /** Core's admission queue: a generated title commits after any queued rename. */
      readonly admit: (threadId: string, perform: () => Promise<void>) => Promise<void>;
      readonly append: (threadId: string, event: Renamed) => Promise<void>;
      readonly rename: (params: HostParams<'thread/rename'>, event: Renamed) => Promise<void>;
    }
  ) {}

  fold(row: HostLogRow): void {
    if (row.event.type === 'thread.renamed') {
      this.titles.set(row.threadId, row.event.title);
    }
  }

  forget(threadId: string): void {
    this.titles.delete(threadId);
  }

  /** A thread never renamed has no committed title; the client shows its default. */
  read(threadId: string): { title?: string } {
    const title = this.titles.get(threadId);
    return title === undefined ? {} : { title };
  }

  async rename(params: HostParams<'thread/rename'>): Promise<{ accepted: true }> {
    await this.core.rename(params, { title: params.title, type: 'thread.renamed' });
    return { accepted: true };
  }

  /**
   * Asks the run's own model for a title while the run's admission is live.
   * Only an untitled thread with no completed run asks; the run joins the
   * request before it closes its admission, and the title commits only if
   * the run completes.
   */
  request(run: HostRunState, admission: HostRunAdmission, runs: Iterable<HostRunState>): void {
    if (
      !admission.generatesThreadTitle ||
      this.pending.has(run.id) ||
      this.titles.has(run.threadId) ||
      [...runs].some((other) => other.threadId === run.threadId && other.outcome === 'completed')
    ) {
      return;
    }
    const title = generateText({
      abortSignal: run.controller.signal,
      maxRetries: 0,
      model: admission.model,
      prompt: run.branch.prompt,
      system: TITLE_INSTRUCTIONS,
    }).then(
      (result) => normalizeTitle(result.text),
      (cause: unknown) => {
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
    run.effects.add(title);
    void title.finally(() => run.effects.delete(title));
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
          if (!this.titles.has(run.threadId)) {
            await this.core.append(run.threadId, { title: generated, type: 'thread.renamed' });
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
