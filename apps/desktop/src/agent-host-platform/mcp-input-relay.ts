import {
  type HostMcpInputPort,
  type HostMcpInputSink,
  HostMcpInputUnboundError,
} from '@brainstrike/agent-host';
import type { McpElicitationSettlement } from '@brainstrike/assistant-contract';
import {
  type McpElicitationFinalizedEvent,
  type McpElicitationPresentation,
  type McpElicitationPresenterAuthority,
  McpElicitationPresenterError,
} from '../mcp/elicitation-presenter';

/** A local display of MCP input the agent host has already committed. */
export interface McpElicitationDisplaySurface {
  /** One display; it sees each presentation only after the host committed it. */
  attach(listener: (presentation: McpElicitationPresentation) => void): () => void;
  observeFinalized(observer: (event: McpElicitationFinalizedEvent) => void): () => void;
}

/**
 * Makes the agent host's Core the presenter's single consent surface: each
 * presentation is bound to its caller and committed to the run log before any
 * display or client sees it, and input Core cannot bind fails closed with
 * `mcp-elicitation-origin-unbound`. Settlement still goes to the presenter,
 * the only settlement writer.
 */
export class McpHostInputRelay implements HostMcpInputPort {
  private display: ((presentation: McpElicitationPresentation) => void) | undefined;
  private readonly detachPresenter: () => void;
  private sink: HostMcpInputSink | undefined;
  private readonly unobserve: () => void;

  readonly surface: McpElicitationDisplaySurface = {
    attach: (listener) => {
      if (this.display) {
        throw new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable');
      }
      this.display = listener;
      return () => {
        if (this.display === listener) {
          this.display = undefined;
        }
      };
    },
    observeFinalized: (observer) => this.presenter.observeFinalized(observer),
  };

  constructor(
    private readonly presenter: Pick<
      McpElicitationPresenterAuthority,
      'attach' | 'observeFinalized' | 'settle'
    >
  ) {
    this.detachPresenter = presenter.attach((presentation) => this.present(presentation));
    try {
      this.unobserve = presenter.observeFinalized(({ code, id }) =>
        this.sink?.retire({ code, id })
      );
    } catch (cause) {
      this.detachPresenter();
      throw cause;
    }
  }

  attach(sink: HostMcpInputSink): () => void {
    if (this.sink) {
      throw new Error('MCP server input already has a host consent surface.');
    }
    this.sink = sink;
    return () => {
      if (this.sink === sink) {
        this.sink = undefined;
      }
    };
  }

  settle(settlement: McpElicitationSettlement): void {
    this.presenter.settle(settlement);
  }

  close(): void {
    this.unobserve();
    this.detachPresenter();
  }

  private async present(presentation: McpElicitationPresentation): Promise<void> {
    const sink = this.sink;
    if (!sink) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable');
    }
    try {
      await sink.present(presentation);
    } catch (cause) {
      throw cause instanceof HostMcpInputUnboundError
        ? new McpElicitationPresenterError('mcp-elicitation-origin-unbound')
        : cause;
    }
    this.display?.(structuredClone(presentation));
  }
}
