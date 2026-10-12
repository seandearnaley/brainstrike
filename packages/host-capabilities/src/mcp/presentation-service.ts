import type { HostMcpPresentationService, HostParams, HostResults } from '@brainstrike/agent-host';
import type { McpPresentationEvent } from '@brainstrike/agent-host/protocol';
import {
  MCP_TASK_LIST_LIMIT,
  type McpElicitationSettlement,
  parseMcpTaskListResult,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  type McpElicitationPresenterAuthority,
  McpElicitationPresenterError,
} from './elicitation-presenter.js';
import type { McpDesktopTaskHostPort } from './task-host.js';

const logger = createLogger('McpPresentationService');

/** The in-process runtime whose Tasks cards and server input the desktop's windows present. */
export interface McpPresentationRuntime {
  readonly elicitationPresenter: Pick<
    McpElicitationPresenterAuthority,
    'attach' | 'observeFinalized' | 'settle'
  >;
  readonly taskHost: Pick<McpDesktopTaskHostPort, 'act' | 'list' | 'subscribe'>;
}

/**
 * The desktop's MCP presentations (BST-1930 c5c), served from the runtime's
 * task host and elicitation presenter. The presenter allows one listener: this
 * service attaches it when a window first follows presentations and keeps it
 * for the host's life, as Main's bridge did for the app's, fanning each change
 * out to every following window. Detaching would finalize every pending input.
 */
export class McpPresentationService implements HostMcpPresentationService {
  readonly #listeners = new Set<(event: McpPresentationEvent) => void>();
  #stop: (() => void) | null = null;
  #closed = false;

  constructor(private readonly runtime: McpPresentationRuntime) {}

  subscribe(listener: (event: McpPresentationEvent) => void): () => void {
    if (this.#closed) {
      throw new Error('MCP presentations are closed');
    }
    this.#listeners.add(listener);
    this.#stop ??= this.#follow();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  tasks(): HostResults['mcp/tasks/list'] {
    // The wire caps the list; the host keeps at most that many live.
    return parseMcpTaskListResult({
      tasks: this.runtime.taskHost.list().tasks.slice(-MCP_TASK_LIST_LIMIT),
    });
  }

  act(request: HostParams<'mcp/tasks/act'>): Promise<HostResults['mcp/tasks/act']> {
    return this.runtime.taskHost.act(request);
  }

  async settle(settlement: McpElicitationSettlement): Promise<void> {
    try {
      this.runtime.elicitationPresenter.settle(settlement);
    } catch (error) {
      // Only the stable code crosses to the window, never a cause's detail.
      const code =
        error instanceof McpElicitationPresenterError
          ? error.code
          : 'mcp-elicitation-settlement-invalid';
      throw new Error(`MCP elicitation settlement failed: ${code}`);
    }
  }

  /** Host shutdown: detach the presenter (its finalizations still reach windows), then stop. */
  close(): void {
    this.#closed = true;
    const stop = this.#stop;
    this.#stop = null;
    stop?.();
    this.#listeners.clear();
  }

  #emit(event: McpPresentationEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        logger.error('MCP presentation listener threw', { error });
      }
    }
  }

  #follow(): () => void {
    const { elicitationPresenter, taskHost } = this.runtime;
    const stopObserving = elicitationPresenter.observeFinalized(({ code, id }) =>
      this.#emit({ code, id, type: 'elicitation.retired' })
    );
    let detach: () => void;
    try {
      detach = elicitationPresenter.attach((presentation) =>
        this.#emit({ presentation, type: 'elicitation.requested' })
      );
    } catch (error) {
      stopObserving();
      throw error;
    }
    const unsubscribeTasks = taskHost.subscribe((task) => this.#emit({ task, type: 'task' }));
    return () => {
      unsubscribeTasks();
      // Detach first so the resulting finalizations still reach the windows.
      detach();
      stopObserving();
    };
  }
}
