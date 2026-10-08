import {
  createMcpAppOrdinaryToolCallPreparer,
  type McpAppToolAdmissionCapability,
  readMcpCreatedTaskResult,
} from '@brainstrike/agent';
import type { McpTaskTrackingCapability } from '@brainstrike/agent/mcp-tasks';
import {
  type ConfiguredMcpServerId,
  type McpAppExecuteRequest,
  type McpAppExecuteResult,
  type McpAppPrepareRequest,
  type McpAppPrepareResult,
  type McpAppReleaseRequest,
  type McpHostPort,
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
  parseMcpAppExecuteResult,
} from '@brainstrike/assistant-contract';
import type { McpDesktopTaskHostPort } from '@brainstrike/host-capabilities/mcp/task-host';
import { getDesktopMcpHostRuntime } from './host-runtime';

type McpDesktopAppHostErrorCode =
  | 'mcp_app_admission_unavailable'
  | 'mcp_app_preparation_duplicate'
  | 'mcp_app_preparation_unavailable';

export class McpDesktopAppHostError extends Error {
  constructor(readonly code: McpDesktopAppHostErrorCode) {
    const detail =
      code === 'mcp_app_admission_unavailable'
        ? 'no live or detached admission of the owning thread admits this server'
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

/** The live assistant run publishing an admission: its run id and the thread it serves. */
export interface McpAppAdmissionRun {
  readonly runId: string;
  readonly threadId: string;
}

/** The process-level MCP connection authority a detached admission executes through. */
export type McpAppsExecutionHostPort = Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>;

export interface McpDesktopAppHostOptions {
  /** Resolved lazily per detach/execute so construction never boots the MCP runtime. */
  readonly resolveHost: () => McpAppsExecutionHostPort;
  /**
   * Durable task authorities a detached call hands a created task to; resolved
   * lazily like `resolveHost`. Without a run there is no runtime tracking
   * capability, so the desktop task host owns app-originated tasks directly.
   */
  readonly resolveTaskHost: () => Pick<McpDesktopTaskHostPort, 'track'>;
}

interface LiveAdmissionEntry {
  readonly admission: McpAppToolAdmissionCapability;
  readonly runId: string;
  readonly state: 'live';
  readonly threadId: string;
}

/**
 * A detached admission outlives its run: the static decision/risk maps stay,
 * execution moves to the host port, and each admitted server is pinned to the
 * exact host generation that was live at detach time.
 */
interface DetachedAdmissionEntry {
  readonly admission: McpAppToolAdmissionCapability;
  readonly generations: ReadonlyMap<ConfiguredMcpServerId, number>;
  readonly runId: string;
  readonly state: 'detached';
  readonly threadId: string;
  readonly unwatch: () => void;
}

type AdmissionEntry = DetachedAdmissionEntry | LiveAdmissionEntry;

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

/**
 * Ordinary admission for app-originated tool calls. Admissions are keyed by
 * the OWNING THREAD: a prepare resolves the admission of the thread whose tool
 * result mounted the app, and only that one — never the most recent run that
 * happens to know the same server. A newer run registering for the same
 * thread supersedes the older one (its preparations are released).
 *
 * Lifetime: live run → detached → superseded/retired. Run disposal releases
 * the run's pending preparations and DETACHES the admission instead of
 * dropping it: the static per-tool decision/risk maps keep gating consent,
 * while execution moves from the run-owned client to the process-level host
 * port (`tools/call` on the configured server). A detached admission is
 * pinned to each server's live host generation and is dropped when that
 * generation retires, the server disappears, or a newer run of the thread
 * registers. Detached calls bypass the run's hooks and telemetry by design.
 *
 * Only runs whose tool map holds at least one app-capable tool
 * (`McpAppToolAdmissionCapability.appCapableToolCount > 0`) register at all:
 * an app-free later run of the same thread therefore does NOT supersede a
 * still-mounted app admission, and never leaves a detached host watch behind.
 */
export class McpDesktopAppHost {
  readonly #admissionsByThread = new Map<string, AdmissionEntry>();
  readonly #preparations = new Map<string, PreparationEntry>();
  /** Ids claimed by an in-flight `prepare` before its entry exists (see `prepare`). */
  readonly #reservedPreparationIds = new Set<string>();
  readonly #resolveHost: () => McpAppsExecutionHostPort;
  readonly #resolveTaskHost: () => Pick<McpTaskTrackingCapability, 'track'>;
  readonly #senders = new Map<number, SenderEntry>();

  constructor(options: McpDesktopAppHostOptions) {
    this.#resolveHost = options.resolveHost;
    this.#resolveTaskHost = options.resolveTaskHost;
  }

  registerAdmission(run: McpAppAdmissionRun, admission: McpAppToolAdmissionCapability): void {
    const current = this.#admissionsByThread.get(run.threadId);
    if (current?.runId === run.runId) {
      throw new Error(`MCP Apps admission for run "${run.runId}" is already registered`);
    }
    if (current !== undefined) {
      this.#dropAdmission(current);
    }
    this.#admissionsByThread.set(run.threadId, {
      admission,
      runId: run.runId,
      state: 'live',
      threadId: run.threadId,
    });
  }

  invalidateAdmission(run: McpAppAdmissionRun): void {
    const current = this.#admissionsByThread.get(run.threadId);
    // A superseded run's preparations were released at supersession; a repeat
    // dispose of an already-detached run must not release its detached calls.
    if (current?.runId !== run.runId || current.state !== 'live') {
      return;
    }
    this.#releaseRunPreparations(run.runId);
    this.#admissionsByThread.delete(run.threadId);
    const detached = this.#detach(current);
    if (detached !== undefined) {
      this.#admissionsByThread.set(run.threadId, detached);
    }
  }

  /**
   * The renderer supplies the preparation id, and preparation awaits the
   * admission preparer, so the id is reserved SYNCHRONOUSLY before the first
   * await: a concurrent duplicate rejects instead of overwriting the first
   * entry (whose executor would then be dropped without release). The
   * reservation is dropped on every exit path; the committed entry replaces it.
   */
  async prepare(
    webContents: McpAppRequestingWebContents,
    request: McpAppPrepareRequest
  ): Promise<McpAppPrepareResult> {
    const { preparationId } = request;
    if (this.#preparations.has(preparationId) || this.#reservedPreparationIds.has(preparationId)) {
      throw new McpDesktopAppHostError('mcp_app_preparation_duplicate');
    }
    this.#reservedPreparationIds.add(preparationId);
    try {
      return await this.#prepareReserved(webContents, request);
    } finally {
      this.#reservedPreparationIds.delete(preparationId);
    }
  }

  async #prepareReserved(
    webContents: McpAppRequestingWebContents,
    request: McpAppPrepareRequest
  ): Promise<McpAppPrepareResult> {
    const entry = this.#resolveAdmission(request.threadId, request.origin.serverId);
    const call = {
      input: request.arguments,
      serverId: request.origin.serverId,
      toolName: request.toolName,
    };
    const prepared =
      entry.state === 'live'
        ? await createMcpAppOrdinaryToolCallPreparer({ admission: entry.admission })(call)
        : this.#prepareDetached(entry, call);
    if (this.#admissionsByThread.get(entry.threadId) !== entry) {
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

  #resolveAdmission(threadId: string, serverId: string): AdmissionEntry {
    const entry = this.#admissionsByThread.get(threadId);
    if (entry === undefined || !entry.admission.serverIds.includes(serverId)) {
      throw new McpDesktopAppHostError('mcp_app_admission_unavailable');
    }
    if (entry.state === 'live') {
      return entry;
    }
    // Detached: the pinned generation must still be the live one. The watch
    // drops retired entries eagerly, but its delivery is microtask-queued, so
    // re-check the snapshot at admission time rather than trust retention.
    const configuredServerId = parseConfiguredMcpServerId(serverId);
    const pinned = entry.generations.get(configuredServerId);
    const live = findServer(this.#resolveHost().snapshot().servers, configuredServerId);
    if (pinned === undefined || live?.generation !== pinned) {
      this.#dropAdmission(entry);
      throw new McpDesktopAppHostError('mcp_app_admission_unavailable');
    }
    return entry;
  }

  /**
   * Detach a live admission onto the host port. Only servers currently live on
   * the host are retained (pinned to their generation); an admission with no
   * live server is dropped outright and later prepares fail typed.
   */
  #detach(entry: LiveAdmissionEntry): DetachedAdmissionEntry | undefined {
    const host = this.#resolveHost();
    const servers = host.snapshot().servers;
    const generations = new Map<ConfiguredMcpServerId, number>();
    for (const serverId of entry.admission.serverIds) {
      const configuredServerId = parseConfiguredMcpServerId(serverId);
      const live = findServer(servers, configuredServerId);
      if (live !== undefined) {
        generations.set(configuredServerId, live.generation);
      }
    }
    if (generations.size === 0) {
      return;
    }
    let detached: DetachedAdmissionEntry | undefined;
    const unwatch = host.watch({ configuredServerIds: [...generations.keys()] }, (event) => {
      if (detached === undefined || this.#admissionsByThread.get(entry.threadId) !== detached) {
        return;
      }
      for (const [configuredServerId, generation] of generations) {
        if (findServer(event.servers, configuredServerId)?.generation !== generation) {
          this.#dropAdmission(detached);
          return;
        }
      }
    });
    detached = {
      admission: entry.admission,
      generations,
      runId: entry.runId,
      state: 'detached',
      threadId: entry.threadId,
      unwatch,
    };
    return detached;
  }

  /**
   * Detached preparation: the admission's static maps still decide allow/ask
   * and the risk category (`admit` touches no run client); execution is one
   * host-port `tools/call`. The app's tool name is already the server-side
   * name — the capability namespace-resolved `serverId.toolName` at build time.
   *
   * A Tasks-capable server may answer with a CreateTaskResult. Exactly like the
   * run-owned app path (`executeMcpTool` with raw retention), the task is
   * handed to the desktop task host so the repository/lifecycle/lease own it,
   * and the canonical CreateTaskResult is returned to the frame without
   * awaiting settlement (the frame bridge bounds inbound requests at 10 s).
   * A task the host cannot track fails the call visibly.
   */
  #prepareDetached(
    entry: DetachedAdmissionEntry,
    call: Readonly<{ input: McpAppPrepareRequest['arguments']; serverId: string; toolName: string }>
  ): Readonly<{
    decision: 'allow' | 'ask';
    execute: PreparationEntry['execute'];
    riskCategory: McpAppPrepareResult['riskCategory'];
  }> {
    const admitted = entry.admission.admit(call);
    const configuredServerId = parseConfiguredMcpServerId(call.serverId);
    return {
      decision: admitted.decision,
      execute: async ({ signal }) => {
        const outcome = await this.#resolveHost().invoke(
          {
            arguments: call.input,
            configuredServerId,
            toolName: call.toolName,
            type: 'tools/call',
          },
          { signal }
        );
        if (outcome.type !== 'tools/call') {
          throw new Error(
            `MCP Apps detached call expected a tools/call result, received ${outcome.type}`
          );
        }
        const createdTask = readMcpCreatedTaskResult(outcome.result);
        if (createdTask !== undefined) {
          await this.#resolveTaskHost().track(
            { configuredServerId, result: createdTask, toolName: call.toolName },
            signal
          );
        }
        return outcome.result;
      },
      riskCategory: admitted.riskCategory,
    };
  }

  #dropAdmission(entry: AdmissionEntry): void {
    if (this.#admissionsByThread.get(entry.threadId) === entry) {
      this.#admissionsByThread.delete(entry.threadId);
    }
    if (entry.state === 'detached') {
      entry.unwatch();
    }
    this.#releaseRunPreparations(entry.runId);
  }

  #releaseRunPreparations(runId: string): void {
    for (const [preparationId, entry] of this.#preparations) {
      if (entry.runId === runId) {
        this.#releasePreparation(preparationId, entry);
      }
    }
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

function findServer(
  servers: readonly McpHostServerSnapshot[],
  configuredServerId: ConfiguredMcpServerId
): McpHostServerSnapshot | undefined {
  return servers.find((server) => server.configuredServerId === configuredServerId);
}

let singleton: McpDesktopAppHost | undefined;

export function getMcpDesktopAppHost(): McpDesktopAppHost {
  if (singleton === undefined) {
    singleton = new McpDesktopAppHost({
      resolveHost: () => getDesktopMcpHostRuntime().host,
      resolveTaskHost: () => getDesktopMcpHostRuntime().taskHost,
    });
  }
  return singleton;
}
