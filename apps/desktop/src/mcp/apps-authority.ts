import {
  createMcpAppOrdinaryToolCallPreparer,
  type McpAppToolAdmissionCapability,
} from '@brainstrike/agent';
import {
  type McpAppExecuteRequest,
  type McpAppExecuteResult,
  type McpAppPrepareRequest,
  type McpAppPrepareResult,
  type McpAppReleaseRequest,
  parseMcpAppExecuteResult,
} from '@brainstrike/assistant-contract';

type McpDesktopAppHostErrorCode =
  | 'mcp_app_admission_unavailable'
  | 'mcp_app_preparation_duplicate'
  | 'mcp_app_preparation_unavailable';

export class McpDesktopAppHostError extends Error {
  constructor(readonly code: McpDesktopAppHostErrorCode) {
    const detail =
      code === 'mcp_app_admission_unavailable'
        ? 'no live run admission is available'
        : code === 'mcp_app_preparation_duplicate'
          ? 'the preparation id is already registered'
          : 'the preparation is not available';
    super(`MCP Apps desktop host failed: ${detail} (${code})`);
    this.name = 'McpDesktopAppHostError';
  }
}

export interface McpAppRequestingWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  on(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

interface AdmissionEntry {
  readonly admission: McpAppToolAdmissionCapability;
  readonly runId: string;
  readonly sequence: number;
}

interface PreparationEntry {
  readonly controller: AbortController;
  readonly execute: (context: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
  phase: 'executing' | 'prepared';
  readonly release: () => void;
  readonly runId: string;
  readonly senderId: number;
}

interface SenderEntry {
  readonly onDestroyed: () => void;
  readonly preparationIds: Set<string>;
  readonly webContents: McpAppRequestingWebContents;
}

export class McpDesktopAppHost {
  readonly #admissions = new Map<string, AdmissionEntry>();
  #admissionSequence = 0;
  readonly #preparations = new Map<string, PreparationEntry>();
  readonly #senders = new Map<number, SenderEntry>();

  registerAdmission(runId: string, admission: McpAppToolAdmissionCapability): void {
    if (this.#admissions.has(runId)) {
      throw new Error(`MCP Apps admission for run "${runId}" is already registered`);
    }
    this.#admissionSequence += 1;
    this.#admissions.set(runId, { admission, runId, sequence: this.#admissionSequence });
  }

  invalidateAdmission(runId: string): void {
    this.#admissions.delete(runId);
    for (const [preparationId, entry] of this.#preparations) {
      if (entry.runId === runId) {
        this.#releasePreparation(preparationId, entry);
      }
    }
  }

  async prepare(
    webContents: McpAppRequestingWebContents,
    request: McpAppPrepareRequest
  ): Promise<McpAppPrepareResult> {
    if (this.#preparations.has(request.preparationId)) {
      throw new McpDesktopAppHostError('mcp_app_preparation_duplicate');
    }
    const entry = this.#resolveAdmission(request.origin.serverId);
    const prepare = createMcpAppOrdinaryToolCallPreparer({ admission: entry.admission });
    const prepared = await prepare({
      input: request.arguments,
      serverId: request.origin.serverId,
      toolName: request.toolName,
    });
    if (this.#admissions.get(entry.runId) !== entry) {
      throw new McpDesktopAppHostError('mcp_app_admission_unavailable');
    }
    if (webContents.isDestroyed()) {
      throw new McpDesktopAppHostError('mcp_app_preparation_unavailable');
    }
    if (prepared.decision === 'deny') {
      throw new Error('MCP Apps ordinary preparer returned an unsupported deny decision');
    }
    const sender = this.#sender(webContents);
    sender.preparationIds.add(request.preparationId);
    const controller = new AbortController();
    this.#preparations.set(request.preparationId, {
      controller,
      execute: prepared.execute,
      phase: 'prepared',
      release: () => controller.abort(new Error('MCP Apps preparation released')),
      runId: entry.runId,
      senderId: webContents.id,
    });
    return { decision: prepared.decision, riskCategory: prepared.riskCategory };
  }

  async execute(
    webContents: McpAppRequestingWebContents,
    request: McpAppExecuteRequest
  ): Promise<McpAppExecuteResult> {
    const entry = this.#requirePreparation(webContents.id, request.preparationId);
    if (entry.phase !== 'prepared') {
      throw new McpDesktopAppHostError('mcp_app_preparation_unavailable');
    }
    entry.phase = 'executing';
    try {
      return parseMcpAppExecuteResult({
        result: await entry.execute({ signal: entry.controller.signal }),
      });
    } finally {
      this.#releasePreparation(request.preparationId, entry);
    }
  }

  async release(
    webContents: McpAppRequestingWebContents,
    request: McpAppReleaseRequest
  ): Promise<void> {
    const entry = this.#requirePreparation(webContents.id, request.preparationId);
    this.#releasePreparation(request.preparationId, entry);
  }

  #resolveAdmission(serverId: string): AdmissionEntry {
    const candidates = Array.from(this.#admissions.values())
      .filter(({ admission }) => admission.serverIds.includes(serverId))
      .sort((left, right) => right.sequence - left.sequence);
    const entry = candidates[0];
    if (entry === undefined) {
      throw new McpDesktopAppHostError('mcp_app_admission_unavailable');
    }
    return entry;
  }

  #sender(webContents: McpAppRequestingWebContents): SenderEntry {
    const current = this.#senders.get(webContents.id);
    if (current !== undefined) {
      if (current.webContents !== webContents) {
        throw new Error(`MCP Apps WebContents id ${webContents.id} changed identity`);
      }
      return current;
    }
    const onDestroyed = (): void => {
      const sender = this.#senders.get(webContents.id);
      if (sender === undefined) {
        return;
      }
      webContents.removeListener('destroyed', onDestroyed);
      for (const preparationId of sender.preparationIds) {
        const entry = this.#preparations.get(preparationId);
        if (entry !== undefined) {
          this.#releasePreparation(preparationId, entry);
        }
      }
      this.#senders.delete(webContents.id);
    };
    const sender = { onDestroyed, preparationIds: new Set<string>(), webContents };
    this.#senders.set(webContents.id, sender);
    webContents.on('destroyed', onDestroyed);
    return sender;
  }

  #requirePreparation(senderId: number, preparationId: string): PreparationEntry {
    const entry = this.#preparations.get(preparationId);
    if (entry === undefined || entry.senderId !== senderId) {
      throw new McpDesktopAppHostError('mcp_app_preparation_unavailable');
    }
    return entry;
  }

  #releasePreparation(preparationId: string, entry: PreparationEntry): void {
    entry.release();
    this.#preparations.delete(preparationId);
    const sender = this.#senders.get(entry.senderId);
    sender?.preparationIds.delete(preparationId);
    if (sender?.preparationIds.size === 0) {
      sender.webContents.removeListener('destroyed', sender.onDestroyed);
      this.#senders.delete(entry.senderId);
    }
  }
}

let singleton: McpDesktopAppHost | undefined;

export function getMcpDesktopAppHost(): McpDesktopAppHost {
  if (singleton === undefined) {
    singleton = new McpDesktopAppHost();
  }
  return singleton;
}
