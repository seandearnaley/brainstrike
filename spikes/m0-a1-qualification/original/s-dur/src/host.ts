// RunHost: single-process owner of every run. Only writer of run_events.
// Each run (root or child) = one streamText loop per leg; model input for every step is rebuilt from the log.
// B2 additions: history window, retry/step defaults, model-instance guard, usage mapping, per-run tool scheduler,
// durable ROOT interactions (AI SDK message-based approvals + execute-less ask/plan tools) with an exactly-once fence,
// transcript redaction at log-append time, branch commands (edit/regenerate/switch).
import { convertToModelMessages, stepCountIs, streamText, tool, type LanguageModel, type ToolSet, type UIMessage, type UIMessageChunk } from 'ai';
import { z } from 'zod';
import type { Decision, HostEvent, InteractionKind, RunStatus } from './events.js';
import { emptyFold, foldMessages, foldRows, type FoldState, type RunReducer } from './fold.js';
import { Coalescer, RunEventLog, type PublishMode } from './log.js';
import { mapStepUsage } from './ported/usage.js';
import type { ModelInformation } from './ported/schema-compat.js';
import { adaptTools, type SchemaAdaptation } from './tool-schema-adapter.js';

let counter = 0;
export const nextId = (p: string) => `${p}_${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** G6: Mastra 1.73 TrailingAssistantGuard continuation text (dist/trip-wire-D2RIN93U.js:1332-1360, non-structured-output branch). */
export const CONTINUE_TEXT = 'Continue.';
/** G5: visible reason on a redacted root approval that cannot survive a restart. */
export const REDACTED_RESTART_REASON = 'Interrupted: the host restarted while this call awaited approval. Its input was redacted before persistence (privacy rule), so the original input no longer exists and the call cannot be resumed. Ask again to re-run it.';

/** Brainstrike defaults (packages/assistant-contract/src/memory-settings.ts:27, stream-options.ts:167-173, agent-runtime.ts:543). */
export const DEFAULT_LAST_MESSAGES = 40;
export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_MAX_RETRIES = 0;

export interface TranscriptProjection {
  input?: (input: unknown) => unknown;
  output?: (output: unknown) => unknown;
  error?: (errorText: string) => string;
  inputDelta?: string;
}
export interface ToolMeta {
  /** read tools run in parallel; mutate tools run one at a time per run, in call order */
  risk: 'read' | 'mutate';
  /** needs human approval (root: durable SDK approval; child: awaited gate inside execute) */
  approval?: boolean;
  /** execute-less human-interaction tool (askUser / submitPlan) */
  interaction?: Exclude<InteractionKind, 'approval'>;
  /** transcript (persistence) projection — the log stores this, the live UI + current run keep the original */
  transcript?: TranscriptProjection;
}

export interface RunCtx {
  runId: string; threadId: string; sessionId: string; depth: number; parentRunId: string | null; label: string;
  background: boolean; parentThreadId?: string; signal: AbortSignal; tools: ToolSet;
  gate: (toolCallId: string, toolName: string, input: unknown, signal?: AbortSignal) => Promise<Decision>;
  publishData: (type: `data-${string}`, id: string, data: unknown) => void;
  /** original (unredacted) tool input/output for this run's redacted tools: memory only, never persisted */
  overlay: Map<string, { input?: unknown; output?: unknown; errorText?: string }>;
  /** the per-leg controller (a resumed run gets a new one) */
  ctrl: AbortController;
  /** tool names the host wrapped with the scheduler (only these get call-order tickets) */
  wrapped: Set<string>;
}
export interface OmAdapter {
  prepare(run: RunCtx, fold: FoldState, messages: UIMessage[], host: RunHost): Promise<{ system?: string; messages: UIMessage[] }>;
}
export interface BuildCtx { fold: FoldState; messages: UIMessage[]; stepNumber: number }
export interface HostOptions {
  log: RunEventLog;
  model: (run: RunCtx) => LanguageModel;
  /** Brainstrike provider id (settings-level, e.g. 'anthropic' | 'openai' | 'openrouter' | 'ollama'); default: model.provider prefix */
  providerId?: (run: RunCtx) => string;
  tools?: (run: RunCtx) => ToolSet;
  toolMeta?: (name: string) => ToolMeta | undefined;
  instructions?: (run: RunCtx, ctx?: BuildCtx) => string;
  /** per-step activeTools (e.g. deferred discovery derived from the model-input messages) */
  activeTools?: (run: RunCtx, ctx: BuildCtx) => string[] | undefined;
  /** "Recent messages" (lastMessages) window; Brainstrike default 40. G4: NOT applied when `om` is set (OM governs history),
   *  as today: @mastra/core 1.73 adds MessageHistory only when `!hasObservationalMemory` (dist/agent-D-eTzWxF.js:19630,19770). */
  lastMessages?: (run: RunCtx) => number;
  /** G1: the model identity the tool-schema compat layer keys on (Mastra semantics: provider + modelId). null = no rewriting.
   *  Default: the LanguageModel's own provider/modelId. */
  toolSchemaTarget?: (run: RunCtx, model: LanguageModel) => ModelInformation | null;
  maxRetries?: number;
  maxDepth?: number; maxSteps?: number; flushMs?: number;
  /** S-DUR D2: listeners (the UI) see a chunk only after its log batch committed (default) or at publish (B4 behaviour) */
  publish?: PublishMode;
  om?: OmAdapter;
  /** force a final synthesis step (activeTools: [], toolChoice: 'none') at this step number */
  finalStepAt?: (run: RunCtx) => number | undefined;
  /** extra per-run streamText options (e.g. providerOptions) */
  streamOptions?: (run: RunCtx) => Record<string, unknown>;
}
export interface RunResult { runId: string; threadId: string; status: RunStatus | 'suspended'; text: string; error?: string }

type StartArgs = { threadId: string; trigger: 'user' | 'wake' | 'child' | 'replay'; depth: number; parentRunId: string | null; label: string; background?: boolean; parentThreadId?: string; sessionId?: string; runId?: string };

/** Default ToolMeta when a tool declares none: fail-safe = mutating (one at a time). */
const DEFAULT_META: ToolMeta = { risk: 'mutate' };

export class RunHost {
  readonly co: Coalescer;
  private folds = new Map<string, FoldState>();
  private controllers = new Map<string, AbortController>();
  private runs = new Map<string, RunCtx>();
  private done = new Map<string, Promise<RunResult>>();
  private activeByThread = new Map<string, string>();
  private outstanding = new Map<string, Set<string>>(); // parentThread -> bg child runIds
  private wakeChain = new Map<string, Promise<void>>();
  private lastWakeSeq = new Map<string, number>();
  private steerQueue = new Map<string, string[]>();
  private gates = new Map<string, { run: RunCtx; toolName: string; resolve: (d: Decision) => void }>();
  private grants = new Set<string>();
  private finishSteps = new Map<string, { n: number; waiters: Array<{ n: number; res: () => void }> }>();
  private listeners: Array<(threadId: string, runId: string, c: UIMessageChunk) => void> = [];
  /** per-run mutation queue: toolCallIds in call order (registered from the stream via toolApproval) */
  private mutQueue = new Map<string, { order: string[]; busy: boolean; waiters: Map<string, () => void> }>();
  private toolNameByCall = new Map<string, string>();
  readonly maxDepth: number; readonly maxSteps: number;
  readonly effects: Array<{ runId: string; label: string; toolName: string; toolCallId: string; at: number }> = [];
  readonly wakes: Array<{ threadId: string; childRunIds: string[] }> = [];
  /** every model handed to streamText (P-G evidence) */
  readonly modelCalls: Array<{ runId: string; kind: string; provider: string; modelId: string }> = [];
  readonly toolSpans: Array<{ runId: string; toolCallId: string; toolName: string; risk: string; start: number; end: number }> = [];
  /** G1 evidence: per-run tool schema adaptations (target, strict, documented-subset violations, wire schema) */
  readonly schemaReports: Array<SchemaAdaptation & { runId: string }> = [];
  /** G6 evidence: steps whose model input ended on an assistant turn and got a continuation user turn */
  readonly prefillGuards: Array<{ runId: string; stepNumber: number }> = [];
  stepLag = 0;

  constructor(readonly opts: HostOptions) {
    if ((globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER !== undefined) throw new Error('RunHost: a global AI_SDK_DEFAULT_PROVIDER is set; string model ids must never resolve');
    this.co = new Coalescer(opts.log, opts.flushMs ?? 20, opts.publish ?? 'after-commit', (t, r, c) => { for (const l of this.listeners) l(t, r, c); });
    this.maxDepth = opts.maxDepth ?? 2; this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  onChunk(fn: (threadId: string, runId: string, c: UIMessageChunk) => void) { this.listeners.push(fn); }
  /** B4: live-only chunk (e.g. MCP progress): listeners see it, the log never does (today's progress is not persisted). */
  publishTransient(run: RunCtx, c: UIMessageChunk) { this.co.show(run.threadId, run.runId, c); }

  // ---------- B4: externally-settled (MCP) interactions ----------
  /** open external interactions: settled by `respond` through the owner's callback (e.g. the MCP elicitation presenter) */
  private external = new Map<string, { run: RunCtx; settle: (decision: Decision, answer?: unknown) => void }>();
  /** Record an interaction that a non-host authority owns (an MCP elicitation inside a tool call). Non-durable: on restart
   *  the boot sweep interrupts it (today: the presenter is process-local and nothing is restored). */
  openExternalInteraction(run: RunCtx, ix: { toolCallId: string; toolName: string; kind: InteractionKind; input: unknown }, settle: (decision: Decision, answer?: unknown) => void): { interactionId: string; appended: Promise<unknown> } {
    const interactionId = nextId('ix');
    this.external.set(interactionId, { run, settle }); // registered synchronously: answerable as soon as the id exists
    const appended = this.appendNow(run.threadId, { type: 'interaction.requested', interactionId, runId: run.runId, toolCallId: ix.toolCallId, toolName: ix.toolName, input: ix.input, kind: ix.kind, durable: false });
    return { interactionId, appended };
  }
  /** The owning authority finalized it without an answer (caller abort, authority retired, presenter closed). */
  async finishExternalInteraction(interactionId: string, reason: string) {
    const e = this.external.get(interactionId);
    if (!e) return;
    this.external.delete(interactionId);
    await this.appendNow(e.run.threadId, { type: 'interaction.responded', interactionId, decision: 'interrupted', reason });
  }
  meta(name: string): ToolMeta { return this.opts.toolMeta?.(name) ?? (name === 'delegate' ? { risk: 'read' } : DEFAULT_META); }

  /** Incremental fold: cached state + rows after its seq.
   *  B4 FIX: serialized per thread. B3's version let two concurrent callers read the same `seq` window and BOTH apply
   *  those rows to the one cached state (double-applied chunks -> duplicate parts / fold errors); B4's UI-style polling
   *  of fold() during a live run exposed it. */
  private foldChains = new Map<string, Promise<unknown>>();
  fold(threadId: string): Promise<FoldState> {
    const next = (this.foldChains.get(threadId) ?? Promise.resolve()).then(async () => {
      const st = this.folds.get(threadId) ?? emptyFold();
      this.folds.set(threadId, st);
      return foldRows(st, await this.opts.log.read(threadId, st.seq));
    });
    this.foldChains.set(threadId, next.catch(() => undefined));
    return next;
  }

  async appendNow(threadId: string, e: HostEvent) { return this.co.appendNow(threadId, e); }

  // ---------- commands ----------
  async sendUserMessage(threadId: string, text: string, meta?: Record<string, unknown>): Promise<RunResult> {
    await this.appendNow(threadId, { type: 'ui.message', message: userMessage(text, meta) });
    return this.startRun({ threadId, trigger: 'user', depth: 0, parentRunId: null, label: 'root' }).done;
  }
  /** Edit = a sibling of the edited user message (same parent) + a new run on that branch. */
  async editUserMessage(threadId: string, sourceId: string, text: string): Promise<RunResult> {
    const fold = await this.fold(threadId);
    if (!fold.messages[sourceId] || fold.messages[sourceId]!.role !== 'user') throw new Error(`editUserMessage: ${sourceId} is not a user message`);
    await this.appendNow(threadId, { type: 'ui.message', message: userMessage(text, { editOf: sourceId }), parentId: fold.parentOf[sourceId] ?? null });
    return this.startRun({ threadId, trigger: 'user', depth: 0, parentRunId: null, label: 'root' }).done;
  }
  /** Regenerate = move the head to the assistant message's parent and run again (the new answer is a sibling). */
  async regenerate(threadId: string, assistantMessageId: string): Promise<RunResult> {
    const fold = await this.fold(threadId);
    const run = Object.values(fold.runs).find((r) => r.messageIds.includes(assistantMessageId));
    if (!run) throw new Error(`regenerate: no run produced ${assistantMessageId}`);
    const parent = fold.parentOf[run.messageIds[0]!];
    if (parent == null) throw new Error(`regenerate: ${assistantMessageId} has no parent`);
    await this.appendNow(threadId, { type: 'thread.head', headId: parent });
    return this.startRun({ threadId, trigger: 'user', depth: 0, parentRunId: null, label: 'root' }).done;
  }
  async switchBranch(threadId: string, headId: string) {
    const fold = await this.fold(threadId);
    if (!fold.messages[headId]) throw new Error(`switchBranch: unknown message ${headId}`);
    await this.appendNow(threadId, { type: 'thread.head', headId });
  }
  /** Continue a thread from its current head WITHOUT a new user message (e.g. after an interrupted run). */
  async continueRun(threadId: string): Promise<RunResult> {
    return this.startRun({ threadId, trigger: 'replay', depth: 0, parentRunId: null, label: 'root-continue' }).done;
  }
  steer(runId: string, text: string) { const q = this.steerQueue.get(runId) ?? []; q.push(text); this.steerQueue.set(runId, q); }
  stop(runId: string) { this.controllers.get(runId)?.abort(new Error('stopped by user')); }

  /** Answer an interaction. Child gates resolve in memory; root interactions are durable (log) and resume the run. */
  async respond(interactionId: string, decision: Decision, answer?: unknown) {
    const x = this.external.get(interactionId);
    if (x) {
      x.settle(decision, answer); // the owner validates first; a refused answer leaves the interaction open
      this.external.delete(interactionId);
      await this.appendNow(x.run.threadId, { type: 'interaction.responded', interactionId, decision, ...(answer !== undefined ? { answer } : {}) });
      return;
    }
    const g = this.gates.get(interactionId);
    if (g) {
      this.gates.delete(interactionId);
      await this.appendNow(g.run.threadId, { type: 'interaction.responded', interactionId, decision, ...(answer !== undefined ? { answer } : {}) });
      if (answer !== undefined) this.askAnswers.set(interactionId, answer);
      if (decision === 'grant-session') this.grants.add(`${g.run.sessionId}:${g.toolName}`);
      g.resolve(decision);
      return;
    }
    return this.respondDurable(interactionId, decision, answer);
  }
  openInteractions() {
    return [...this.gates.entries()].map(([id, g]) => ({ interactionId: id, runId: g.run.runId, label: g.run.label, toolName: g.toolName }));
  }
  /** Durable (root) open interactions, read from the log. */
  async openDurableInteractions(threadId: string) {
    return Object.values((await this.fold(threadId)).interactions).filter((i) => i.durable && i.status === 'open');
  }
  result(runId: string) { return this.done.get(runId); }
  runByLabel(label: string) { return [...this.runs.values()].find((r) => r.label === label); }
  isActive(runId: string) { return this.controllers.has(runId); }
  async waitIdle() {
    for (;;) {
      await Promise.all([...this.done.values()]);
      await Promise.all([...this.wakeChain.values()]);
      if (this.activeByThread.size === 0 && [...this.outstanding.values()].every((s) => s.size === 0)) { await this.co.flush(); return; }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---------- runs ----------
  private makeCtx(a: StartArgs & { runId: string }): RunCtx {
    const ctrl = new AbortController();
    const run: RunCtx = {
      runId: a.runId, threadId: a.threadId, sessionId: a.sessionId ?? a.threadId, depth: a.depth, parentRunId: a.parentRunId, label: a.label,
      background: !!a.background, parentThreadId: a.parentThreadId, signal: ctrl.signal, tools: {}, overlay: new Map(), ctrl, wrapped: new Set(),
      gate: (tcid, name, input, sig) => (run.depth === 0 ? Promise.resolve<Decision>('approve') : this.gate(run, tcid, name, input, sig)),
      publishData: (type, id, data) => this.publish(run, { type, id, data } as UIMessageChunk),
    };
    const raw = { ...(this.opts.tools?.(run) ?? {}), ...(run.depth < this.maxDepth ? { delegate: this.delegateTool(run) } : {}) };
    run.tools = Object.fromEntries(Object.entries(raw).map(([n, t]) => [n, this.wrapTool(run, n, this.replayCommittedModelOutput(run, t))])) as ToolSet;
    return run;
  }

  startRun(a: StartArgs) {
    const runId = a.runId ?? nextId('run');
    const run = this.makeCtx({ ...a, runId });
    this.controllers.set(runId, run.ctrl);
    this.activeByThread.set(a.threadId, runId);
    this.runs.set(runId, run);
    const done = this.execute(run, a.trigger, 1);
    this.done.set(runId, done);
    return { runId, done };
  }

  private publish(run: RunCtx, c: UIMessageChunk) {
    this.co.push(run.threadId, run.runId, this.projectForLog(run, c));
    this.commitPayloadTransform(run, c);
    // S-DUR D2: the UI gets the display projection through the coalescer (after-commit: only once the row committed)
    this.co.show(run.threadId, run.runId, this.projectPayload(run, c, 'display'));
    if (c.type === 'finish-step') {
      const f = this.finishSteps.get(run.runId)!; f.n++;
      f.waiters = f.waiters.filter((w) => (w.n <= f.n ? (w.res(), false) : true));
    }
  }
  private waitFinishSteps(runId: string, n: number) {
    const f = this.finishSteps.get(runId)!;
    if (f.n >= n) return Promise.resolve();
    return new Promise<void>((res) => f.waiters.push({ n, res }));
  }

  // ---------- B4: tool payload transforms (re-homes Mastra's display/transcript `transform`, @mastra/core 1.73
  // payload-transform.ts: tool.transform[target].output(context) for phase 'output-available') ----------
  private toolInputs = new Map<string, unknown>();
  private toolOf(run: RunCtx, toolCallId: string, toolName?: string) {
    const name = toolName ?? this.toolNameByCall.get(toolCallId);
    return name ? (run.tools[name] as { transform?: Record<string, { output?: (ctx: Record<string, unknown>) => unknown }>; toModelOutput?: (o: { toolCallId: string; input: unknown; output: unknown }) => unknown } | undefined) : undefined;
  }
  /** display -> live listeners, transcript -> the log (both only for tool-output-available, as Mastra's output phase) */
  private projectPayload(run: RunCtx, c: UIMessageChunk, target: 'display' | 'transcript'): UIMessageChunk {
    if (c.type === 'tool-input-available') this.toolInputs.set(c.toolCallId, c.input);
    if (c.type !== 'tool-output-available') return c;
    const fn = this.toolOf(run, c.toolCallId)?.transform?.[target]?.output;
    if (!fn) return c;
    const name = this.toolNameByCall.get(c.toolCallId);
    return { ...c, output: fn({ output: c.output, toolCallId: c.toolCallId, toolName: name, input: this.toolInputs.get(c.toolCallId), phase: 'output-available', target }) } as UIMessageChunk;
  }
  /** When the transcript projection replaced the output, commit the model view now (Mastra: computeModelOutputProviderMetadata
   *  at tool-result commit, stored at providerMetadata.mastra.modelOutput). The log is then self-sufficient for the model. */
  private commitPayloadTransform(run: RunCtx, c: UIMessageChunk) {
    if (c.type !== 'tool-output-available') return;
    const tool = this.toolOf(run, c.toolCallId);
    const fn = tool?.transform?.transcript?.output;
    if (!fn || !tool?.toModelOutput) return;
    const transcript = fn({ output: c.output, toolCallId: c.toolCallId, toolName: this.toolNameByCall.get(c.toolCallId), input: this.toolInputs.get(c.toolCallId), phase: 'output-available', target: 'transcript' });
    if (transcript === c.output) return;
    const modelOutput = tool.toModelOutput({ toolCallId: c.toolCallId, input: this.toolInputs.get(c.toolCallId), output: c.output });
    if (modelOutput && typeof (modelOutput as { then?: unknown }).then === 'function') throw new Error(`tool ${this.toolNameByCall.get(c.toolCallId)}: async toModelOutput cannot be committed at append time`);
    this.appendNow(run.threadId, { type: 'tool.model-output', runId: run.runId, toolCallId: c.toolCallId, modelOutput }).catch((e: unknown) => run.ctrl.abort(e));
  }

  /** P-X: transcript projection at log-append time. Listeners (live UI) get the original chunk. */
  private projectForLog(run: RunCtx, c: UIMessageChunk): UIMessageChunk {
    c = this.projectPayload(run, c, 'transcript');
    const anyC = c as Record<string, any>;
    if (typeof anyC.toolCallId !== 'string') return c;
    if (anyC.toolName) this.toolNameByCall.set(anyC.toolCallId, anyC.toolName);
    const name = anyC.toolName ?? this.toolNameByCall.get(anyC.toolCallId);
    const tp = name ? this.meta(name).transcript : undefined;
    if (!tp) return c;
    const o = run.overlay.get(anyC.toolCallId) ?? {};
    run.overlay.set(anyC.toolCallId, o);
    switch (c.type) {
      case 'tool-input-delta': return { ...c, inputTextDelta: tp.inputDelta ?? '' };
      case 'tool-input-available': o.input = c.input; return { ...c, input: tp.input ? tp.input(c.input) : c.input };
      case 'tool-input-error': o.input = c.input; return { ...c, input: tp.input ? tp.input(c.input) : c.input, errorText: tp.error ? tp.error(c.errorText) : c.errorText };
      case 'tool-output-available': o.output = c.output; return { ...c, output: tp.output ? tp.output(c.output) : c.output };
      case 'tool-output-error': o.errorText = c.errorText; return { ...c, errorText: tp.error ? tp.error(c.errorText) : c.errorText };
      default: return c;
    }
  }

  private providerOf(run: RunCtx, model: LanguageModel) {
    return this.opts.providerId?.(run) ?? (model as { provider: string }).provider.split('.')[0]!;
  }

  private async execute(run: RunCtx, trigger: StartArgs['trigger'], leg: number): Promise<RunResult> {
    const ctrl = run.ctrl;
    this.finishSteps.set(run.runId, { n: 0, waiters: [] });
    const model = this.opts.model(run);
    // P-G: models are always provider instances; a string id would resolve through the global provider (AI Gateway).
    if (typeof model !== 'object' || model === null || !('specificationVersion' in model)) throw new Error(`RunHost: model for run ${run.runId} is not a provider instance: ${String(model)}`);
    // G1: per-provider tool-schema rewriting (idempotent: adapted tools no longer carry a zod schema)
    const target = this.opts.toolSchemaTarget ? this.opts.toolSchemaTarget(run, model) : { provider: (model as { provider: string }).provider, modelId: (model as { modelId: string }).modelId };
    if (target) {
      const reports: SchemaAdaptation[] = [];
      run.tools = adaptTools(run.tools, target, reports);
      for (const r of reports) this.schemaReports.push({ ...r, runId: run.runId });
    }
    let messageId: string;
    if (leg === 1) {
      messageId = nextId('msg');
      const head = (await this.fold(run.threadId)).head;
      await this.appendNow(run.threadId, { type: 'run.started', runId: run.runId, parentRunId: run.parentRunId, depth: run.depth, messageId, trigger, background: run.background, parentThreadId: run.parentThreadId, provider: this.providerOf(run, model), sdkProvider: model.provider, modelId: model.modelId, parentMessageId: head, historyCutoffId: head, label: run.label, sessionId: run.sessionId });
    } else {
      const r = (await this.fold(run.threadId)).runs[run.runId]!;
      messageId = r.messageIds.at(-1)!;
      await this.appendNow(run.threadId, { type: 'run.resumed', runId: run.runId, leg });
    }
    let status: RunStatus = 'completed';
    let error: string | undefined;
    let stepNo = 0;
    try {
      const initial = await this.buildInput(run, 0, leg);
      this.modelCalls.push({ runId: run.runId, kind: 'streamText', provider: model.provider, modelId: model.modelId });
      const extra = this.opts.streamOptions?.(run) ?? {};
      const userStepEnd = extra.onStepEnd as ((e: any) => unknown) | undefined;
      const result = streamText({
        ...extra,
        model,
        tools: run.tools,
        instructions: initial.instructions,
        messages: initial.messages,
        abortSignal: ctrl.signal,
        maxRetries: this.opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        stopWhen: stepCountIs(this.maxSteps),
        toolApproval: ({ toolCall }) => this.approvalFor(run, toolCall.toolName, toolCall.toolCallId, (toolCall as { providerExecuted?: boolean }).providerExecuted),
        prepareStep: async ({ stepNumber }) => {
          // leg >= 2, step 0: the SDK has just executed approved tool calls and appended their results; do not override its messages
          // no tool runs between steps: drop any ticket whose call never executed (stream-retry boundary, aborted step)
          const mq = this.mutQueue.get(run.runId); if (mq && !mq.busy) mq.order = [];
          if (stepNumber === 0) return leg === 1 ? initial.step : { ...initial.step, messages: undefined };
          if ((this.finishSteps.get(run.runId)?.n ?? 0) < stepNumber) this.stepLag++;
          await this.waitFinishSteps(run.runId, stepNumber); // fold must contain the previous step's tail
          return (await this.buildInput(run, stepNumber, leg)).step;
        },
        onStepEnd: async (e: any) => {
          await this.appendNow(run.threadId, { type: 'run.usage', runId: run.runId, step: stepNo++, provider: this.providerOf(run, model), usage: mapStepUsage(this.providerOf(run, model), e.usage, e.providerMetadata) });
          await userStepEnd?.(e);
        },
        onError: ({ error: e }) => { if (!ctrl.signal.aborted) { status = 'failed'; error = String((e as Error)?.message ?? e); } },
      } as Parameters<typeof streamText>[0]);
      for await (const c of result.toUIMessageStream({ sendReasoning: true, generateMessageId: () => messageId, onError: (e) => String((e as Error)?.message ?? e) })) this.publish(run, c);
      if (ctrl.signal.aborted) status = 'interrupted';
    } catch (e) {
      status = ctrl.signal.aborted ? 'interrupted' : 'failed';
      if (!ctrl.signal.aborted) error = String((e as Error)?.message ?? e);
    }
    // ROOT durable interactions: the leg ended on pending approvals / execute-less interaction tools -> suspend (no heal)
    if (status === 'completed' && run.depth === 0) {
      const pending = await this.collectDurableInteractions(run);
      if (pending.length > 0) {
        await this.appendNow(run.threadId, { type: 'run.suspended', runId: run.runId, interactionIds: pending });
        this.controllers.delete(run.runId);
        if (this.activeByThread.get(run.threadId) === run.runId) this.activeByThread.delete(run.threadId);
        return { runId: run.runId, threadId: run.threadId, status: 'suspended', text: lastAssistantText(await this.fold(run.threadId), run.runId) };
      }
    }
    return this.finishRun(run, status, error);
  }

  private async finishRun(run: RunCtx, status: RunStatus, error?: string): Promise<RunResult> {
    await this.healRun(run.threadId, run.runId, status === 'interrupted' ? 'Interrupted: run stopped before this tool finished.' : 'Run failed before this tool finished.');
    await this.appendNow(run.threadId, { type: 'run.finished', runId: run.runId, status, ...(error ? { error } : {}) });
    const text = lastAssistantText(await this.fold(run.threadId), run.runId);
    this.controllers.delete(run.runId);
    this.mutQueue.delete(run.runId);
    if (this.activeByThread.get(run.threadId) === run.runId) this.activeByThread.delete(run.threadId);
    if (run.background && run.parentThreadId) {
      await this.appendNow(run.parentThreadId, { type: 'child.terminal', childRunId: run.runId, childThreadId: run.threadId, status, text, background: true });
      this.outstanding.get(run.parentThreadId)?.delete(run.runId);
      void this.maybeWake(run.parentThreadId);
    }
    void this.maybeWake(run.threadId);
    return { runId: run.runId, threadId: run.threadId, status, text, ...(error ? { error } : {}) };
  }

  /** Rebuild model input from the log: active branch -> OM -> lastMessages window -> redaction overlay -> ModelMessages. */
  private async buildInput(run: RunCtx, stepNumber: number, leg = 1) {
    const q = this.steerQueue.get(run.runId);
    if (q?.length) for (const text of q.splice(0)) await this.appendNow(run.threadId, { type: 'ui.message', message: userMessage(text, { steer: true }) });
    await this.co.flush();
    const fold = await this.fold(run.threadId);
    let messages = foldMessages(fold);
    let omSystem: string | undefined;
    if (this.opts.om) {
      const r = await this.opts.om.prepare(run, fold, messages, this);
      messages = r.messages;
      omSystem = r.system;
    }
    // G4: with OM on, OM governs history and "Recent messages" (lastMessages) is not applied (today's Mastra behaviour)
    if (!this.opts.om) messages = applyHistoryWindow(messages, fold.runs[run.runId]?.historyCutoffId ?? null, this.opts.lastMessages?.(run) ?? DEFAULT_LAST_MESSAGES);
    messages = structuredClone(messages);
    if (run.overlay.size) applyOverlay(messages, run.overlay);
    const ctx: BuildCtx = { fold, messages, stepNumber };
    let instructions = this.opts.instructions?.(run, ctx) ?? 'You are a helpful assistant.';
    if (omSystem) instructions = `${instructions}\n\n${omSystem}`;
    const modelMessages = await convertToModelMessages(messages, { tools: run.tools });
    // G6: never end the prompt on an assistant turn (Anthropic >=4.6 rejects it as prefill; Gemini 3+ rejects any trailing
    // model turn). Within a run a step always ends on a user/tool turn, so this only fires for runs started from history
    // ending on an assistant message (continue-after-interrupt). Prompt-only: the continuation is never persisted.
    if (modelMessages.at(-1)?.role === 'assistant') {
      modelMessages.push({ role: 'user', content: [{ type: 'text', text: CONTINUE_TEXT }] });
      this.prefillGuards.push({ runId: run.runId, stepNumber });
    }
    const finalAt = this.opts.finalStepAt?.(run) ?? this.maxSteps - 1;
    const isFinal = stepNumber >= finalAt;
    const active = this.opts.activeTools?.(run, ctx);
    return {
      instructions, messages: modelMessages, uiMessages: messages, leg,
      step: { instructions, messages: modelMessages as typeof modelMessages | undefined, ...(isFinal ? { activeTools: [] as never[], toolChoice: 'none' as const } : active ? { activeTools: active as never[] } : {}) },
    };
  }

  /** Every stop mid-tool must leave valid history: close open parts, synthesize interrupted tool results. */
  async healRun(threadId: string, runId: string, errorText: string) {
    await this.co.flush();
    const fold = await this.fold(threadId);
    const r: RunReducer | undefined = fold.reducers[runId];
    if (!r) return;
    const chunks: UIMessageChunk[] = [];
    for (const id of Object.keys(r.activeText)) chunks.push({ type: 'text-end', id });
    for (const id of Object.keys(r.activeReasoning)) chunks.push({ type: 'reasoning-end', id });
    for (const p of r.message.parts as Array<Record<string, any>>) {
      if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) continue;
      if (p.state === 'input-streaming') chunks.push({ type: 'tool-input-available', toolCallId: p.toolCallId, toolName: p.type === 'dynamic-tool' ? p.toolName : p.type.slice(5), input: p.input ?? {} });
      const started = fold.execStarted[p.toolCallId] != null;
      if (p.state === 'input-streaming' || p.state === 'input-available' || (p.state === 'output-available' && p.preliminary) || p.state === 'approval-requested' || p.state === 'approval-responded') {
        chunks.push({ type: 'tool-output-error', toolCallId: p.toolCallId, errorText: started ? `${errorText} (execution had started; not re-executed)` : errorText });
      }
    }
    if (chunks.length === 0) return;
    await this.co.appendNow(threadId, { type: 'ui.chunk', runId, chunks }, chunks.length, chunks.map((c) => ({ threadId, runId, c })));
  }

  // ---------- P-T scheduler ----------
  /** Called by the SDK for every tool-call chunk IN STREAM ORDER (execute-tools-from-stream.ts transform). */
  private approvalFor(run: RunCtx, toolName: string, toolCallId: string, providerExecuted?: boolean): 'user-approval' | undefined {
    const m = this.meta(toolName);
    const needsUser = run.depth === 0 && m.approval && !this.grants.has(`${run.sessionId}:${toolName}`);
    // a ticket only for calls the host's wrapper will actually execute (SDK-bound tools like toolSearch are never wrapped)
    if (!needsUser && !providerExecuted && run.wrapped.has(toolName)) this.queueOf(run.runId).order.push(toolCallId);
    return needsUser ? 'user-approval' : undefined;
  }
  private queueOf(runId: string) {
    let q = this.mutQueue.get(runId);
    if (!q) { q = { order: [], busy: false, waiters: new Map() }; this.mutQueue.set(runId, q); }
    return q;
  }
  private acquire(runId: string, toolCallId: string): Promise<void> {
    const q = this.queueOf(runId);
    // approved calls executed at the start of a resumed leg were never streamed in this leg: they queue on invocation
    if (!q.order.includes(toolCallId)) q.order.push(toolCallId);
    return new Promise((res) => { q.waiters.set(toolCallId, res); this.pump(q); });
  }
  private release(runId: string, toolCallId: string) {
    const q = this.queueOf(runId);
    q.order.splice(q.order.indexOf(toolCallId), 1);
    q.busy = false;
    this.pump(q);
  }
  private pump(q: { order: string[]; busy: boolean; waiters: Map<string, () => void> }) {
    if (q.busy) return;
    const next = q.order[0];
    const w = next !== undefined ? q.waiters.get(next) : undefined;
    if (!w) return;
    q.busy = true; q.waiters.delete(next!); w();
  }

  /** A committed model view wins over re-projecting the logged output (Mastra MessageList: storedModelOutputs by toolCallId). */
  private replayCommittedModelOutput(run: RunCtx, t: any): any {
    if (typeof t?.toModelOutput !== 'function') return t;
    const inner = t.toModelOutput;
    return { ...t, toModelOutput: (o: { toolCallId: string; input: unknown; output: unknown }) => {
      const committed = this.folds.get(run.threadId)?.modelOutputs?.[o.toolCallId];
      return committed !== undefined ? committed : inner(o);
    } };
  }

  private wrapTool(run: RunCtx, name: string, t: any): any {
    const m = this.meta(name);
    if (m.interaction) {
      // root: execute-less (the loop stops; the answer arrives durably). child: awaited gate returning the answer.
      if (run.depth === 0) return { ...t, execute: undefined };
      return { ...t, execute: async (input: unknown, o: { toolCallId: string; abortSignal?: AbortSignal }) => this.askGate(run, o.toolCallId, name, m.interaction!, input, o.abortSignal) };
    }
    if (!t.execute || m.risk === 'read' || t[Symbol.for('vercel.ai.toolSearch')] === true) return t;
    run.wrapped.add(name);
    const inner = t.execute;
    const host = this;
    const durableFence = run.depth === 0 && m.approval;
    const before = async (toolCallId: string) => {
      await host.acquire(run.runId, toolCallId);
      if (durableFence) await host.appendNow(run.threadId, { type: 'tool.exec.started', runId: run.runId, toolCallId, toolName: name });
      return performance.now();
    };
    const span = (toolCallId: string, start: number) => host.toolSpans.push({ runId: run.runId, toolCallId, toolName: name, risk: m.risk, start, end: performance.now() });
    if (inner.constructor?.name === 'AsyncGeneratorFunction') {
      return { ...t, execute: async function* (input: unknown, o: { toolCallId: string }) { const s = await before(o.toolCallId); try { yield* inner(input, o); } finally { span(o.toolCallId, s); host.release(run.runId, o.toolCallId); } } };
    }
    return { ...t, execute: async (input: unknown, o: { toolCallId: string }) => { const s = await before(o.toolCallId); try { return await inner(input, o); } finally { span(o.toolCallId, s); host.release(run.runId, o.toolCallId); } } };
  }

  // ---------- durable ROOT interactions ----------
  private async collectDurableInteractions(run: RunCtx): Promise<string[]> {
    await this.co.flush();
    const fold = await this.fold(run.threadId);
    const known = new Set(Object.values(fold.interactions).map((i) => i.toolCallId));
    const out: string[] = [];
    const ids = fold.runs[run.runId]?.messageIds ?? [];
    for (const id of ids) for (const p of (fold.messages[id]?.parts ?? []) as Array<Record<string, any>>) {
      if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) continue;
      const name = p.type === 'dynamic-tool' ? p.toolName : p.type.slice(5);
      const m = this.meta(name);
      const pendingApproval = p.state === 'approval-requested' && !p.approval?.isAutomatic;
      const pendingAnswer = m.interaction && p.state === 'input-available';
      if (!pendingApproval && !pendingAnswer) continue;
      if (known.has(p.toolCallId)) { const ix = Object.values(fold.interactions).find((i) => i.toolCallId === p.toolCallId)!; if (ix.status === 'open') out.push(ix.interactionId); continue; }
      const interactionId = nextId('ix');
      await this.appendNow(run.threadId, { type: 'interaction.requested', interactionId, runId: run.runId, toolCallId: p.toolCallId, toolName: name, input: p.input, kind: pendingApproval ? 'approval' : m.interaction!, durable: true, ...(pendingApproval ? { approvalId: p.approval.id } : {}) });
      out.push(interactionId);
    }
    return out;
  }

  private async findDurable(interactionId: string) {
    for (const threadId of await this.opts.log.threads()) {
      const fold = await this.fold(threadId);
      const ix = fold.interactions[interactionId];
      if (ix) return { threadId, fold, ix };
    }
    throw new Error(`no interaction ${interactionId}`);
  }

  private resuming = new Map<string, Promise<RunResult>>();
  private async respondDurable(interactionId: string, decision: Decision, answer?: unknown): Promise<void> {
    const { threadId, fold, ix } = await this.findDurable(interactionId);
    if (!ix.durable) throw new Error(`interaction ${interactionId} is not durable (child gates are answered in memory only)`);
    if (ix.status !== 'open') throw new Error(`interaction ${interactionId} is already ${ix.status}`);
    const run = fold.runs[ix.runId]!;
    if (run.status !== 'suspended') throw new Error(`run ${ix.runId} is ${run.status}, not suspended`);
    await this.appendNow(threadId, { type: 'interaction.responded', interactionId, decision, ...(answer !== undefined ? { answer } : {}) });
    if (ix.kind === 'approval') {
      if (decision === 'grant-session') this.grants.add(`${run.sessionId ?? threadId}:${ix.toolName}`);
      await this.co.appendNow(threadId, { type: 'ui.chunk', runId: ix.runId, chunks: [{ type: 'tool-approval-response', approvalId: ix.approvalId!, approved: decision !== 'deny', ...(decision === 'deny' ? { reason: 'The user declined this tool call.' } : {}) } as UIMessageChunk] }, 1);
    } else {
      await this.co.appendNow(threadId, { type: 'ui.chunk', runId: ix.runId, chunks: [{ type: 'tool-output-available', toolCallId: ix.toolCallId, output: { decision, ...(answer !== undefined ? { answer } : {}) } } as UIMessageChunk] }, 1);
    }
    if (process.env.B2_CRASH_POINT === 'after-respond') process.kill(process.pid, 'SIGKILL'); // spike crash-injection point
    const after = await this.fold(threadId);
    const stillOpen = Object.values(after.interactions).some((i) => i.runId === ix.runId && i.durable && i.status === 'open');
    if (!stillOpen) this.resume(threadId, ix.runId);
  }

  /** Boot hook (after bootSweep): resume root runs whose durable interactions were ALL answered but whose resume leg never started. */
  async resumeAnswered(): Promise<string[]> {
    const resumed: string[] = [];
    for (const threadId of await this.opts.log.threads()) {
      const fold = await this.fold(threadId);
      for (const r of Object.values(fold.runs)) {
        if (r.status !== 'suspended' || r.depth !== 0) continue;
        const ixs = Object.values(fold.interactions).filter((i) => i.runId === r.runId && i.durable);
        if (ixs.length > 0 && ixs.every((i) => i.status === 'answered')) { void this.resume(threadId, r.runId); resumed.push(r.runId); }
      }
    }
    return resumed;
  }

  /** Resume a suspended root run as a new leg of the same run (same assistant message). */
  resume(threadId: string, runId: string): Promise<RunResult> {
    const existing = this.resuming.get(runId);
    if (existing) return existing;
    const p = (async () => {
      const fold = await this.fold(threadId);
      const info = fold.runs[runId]!;
      let run = this.runs.get(runId);
      if (!run) { run = this.makeCtx({ runId, threadId, trigger: 'user', depth: info.depth, parentRunId: info.parentRunId, label: info.label ?? 'root', sessionId: info.sessionId }); this.runs.set(runId, run); }
      else { const ctrl = new AbortController(); run.ctrl = ctrl; run.signal = ctrl.signal; }
      this.controllers.set(runId, run.ctrl);
      this.activeByThread.set(threadId, runId);
      return this.execute(run, 'user', info.legs + 1);
    })();
    this.resuming.set(runId, p);
    this.done.set(runId, p);
    void p.finally(() => this.resuming.delete(runId));
    return p;
  }

  // ---------- child approvals (awaited, canonical: interrupted on restart) ----------
  private async gate(run: RunCtx, toolCallId: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<Decision> {
    if (this.grants.has(`${run.sessionId}:${toolName}`)) return 'grant-session';
    const interactionId = nextId('ix');
    const p = new Promise<Decision>((resolve, reject) => {
      this.gates.set(interactionId, { run, toolName, resolve });
      signal?.addEventListener('abort', () => {
        if (!this.gates.delete(interactionId)) return;
        void this.appendNow(run.threadId, { type: 'interaction.responded', interactionId, decision: 'interrupted' });
        reject(new Error('aborted while awaiting approval'));
      }, { once: true });
    });
    const tp = this.meta(toolName).transcript;
    await this.appendNow(run.threadId, { type: 'interaction.requested', interactionId, runId: run.runId, toolCallId, toolName, input: tp?.input ? tp.input(input) : input, kind: 'approval', durable: false });
    return p;
  }
  private askAnswers = new Map<string, unknown>();
  private async askGate(run: RunCtx, toolCallId: string, toolName: string, kind: Exclude<InteractionKind, 'approval'>, input: unknown, signal?: AbortSignal) {
    const interactionId = nextId('ix');
    const p = new Promise<Decision>((resolve, reject) => {
      this.gates.set(interactionId, { run, toolName, resolve });
      signal?.addEventListener('abort', () => { if (this.gates.delete(interactionId)) reject(new Error('aborted while awaiting an answer')); }, { once: true });
    });
    await this.appendNow(run.threadId, { type: 'interaction.requested', interactionId, runId: run.runId, toolCallId, toolName, input, kind, durable: false });
    const decision = await p;
    return { decision, answer: this.askAnswers.get(interactionId) };
  }
  /** Session grants also release already-pending gates for the same tool in the same session. */
  async releaseByGrant(sessionId: string, toolName: string) {
    for (const [id, g] of [...this.gates]) if (g.run.sessionId === sessionId && g.toolName === toolName) await this.respond(id, 'grant-session');
  }
  recordEffect(run: RunCtx, toolName: string, toolCallId: string) { this.effects.push({ runId: run.runId, label: run.label, toolName, toolCallId, at: performance.now() }); }

  // ---------- subagents ----------
  private delegateTool(run: RunCtx) {
    return tool({
      description: 'Delegate a task to a subagent. background=true returns immediately; results arrive later as an automated message.',
      inputSchema: z.object({ task: z.string(), label: z.string(), background: z.boolean() }),
      execute: async ({ task, label, background }, { abortSignal }) => {
        const childRunId = nextId('run');
        const childThread = `${run.threadId}/child:${childRunId}`;
        await this.appendNow(childThread, { type: 'ui.message', message: userMessage(task, { delegatedBy: run.runId }) });
        if (background) { const s = this.outstanding.get(run.threadId) ?? new Set(); s.add(childRunId); this.outstanding.set(run.threadId, s); }
        const child = this.startRun({ runId: childRunId, threadId: childThread, trigger: 'child', depth: run.depth + 1, parentRunId: run.runId, label, background, parentThreadId: run.threadId, sessionId: run.sessionId });
        run.publishData('data-child-run', childRunId, { childRunId, label, background, status: 'running' });
        if (background) return { childRunId, status: 'started' as const };
        const stopChild = () => this.stop(childRunId);
        abortSignal?.addEventListener('abort', stopChild, { once: true });
        const res = await child.done;
        abortSignal?.removeEventListener('abort', stopChild);
        run.publishData('data-child-run', childRunId, { childRunId, label, background, status: res.status });
        return { childRunId, status: res.status, text: res.text };
      },
    });
  }

  /** Background children terminal -> exactly one batched continuation of the parent thread. */
  private maybeWake(threadId: string): Promise<void> {
    const prev = this.wakeChain.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if ((this.outstanding.get(threadId)?.size ?? 0) > 0 || this.activeByThread.has(threadId)) return;
      const fold = await this.fold(threadId);
      const since = this.lastWakeSeq.get(threadId) ?? 0;
      const batch = fold.childTerminals.filter((t) => t.seq > since && t.background);
      if (batch.length === 0) return;
      this.lastWakeSeq.set(threadId, fold.seq);
      const text = `[automated] ${batch.length} background task(s) finished:\n${batch.map((b) => `- ${b.childRunId} (${b.status}): ${b.text}`).join('\n')}`;
      await this.appendNow(threadId, { type: 'ui.message', message: userMessage(text, { automated: true, childRunIds: batch.map((b) => b.childRunId) }) });
      this.wakes.push({ threadId, childRunIds: batch.map((b) => b.childRunId) });
      this.startRun({ threadId, trigger: 'wake', depth: 0, parentRunId: null, label: 'root-wake' });
    });
    this.wakeChain.set(threadId, next.catch(() => undefined));
    return next;
  }

  // ---------- boot ----------
  /**
   * Restart sweep (zero model calls):
   *  - ROOT runs suspended on durable interactions stay suspended; their interactions stay open (answerable after restart).
   *    A durable approval whose effect had started (tool.exec.started, no output) is healed as interrupted, never re-run.
   *    A durable interaction on a REDACTED tool cannot resume (its raw input was never persisted) -> interrupted.
   *  - everything else in flight (running roots, all children and their gates) -> healed + interrupted (canonical).
   */
  async bootSweep() {
    const report = { interactions: 0, runs: 0, childTerminals: 0, keptSuspended: 0, keptOpenInteractions: 0, fencedNotReExecuted: 0, redactedInterrupted: 0 };
    for (const threadId of await this.opts.log.threads()) {
      const fold = await this.fold(threadId);
      for (const r of Object.values(fold.runs)) {
        if (r.status === 'suspended' && r.depth === 0) {
          const ixs = Object.values(fold.interactions).filter((i) => i.runId === r.runId && i.durable);
          const redacted = ixs.filter((i) => i.status === 'open' && this.meta(i.toolName).transcript);
          if (redacted.length === 0) {
            report.keptSuspended++;
            report.keptOpenInteractions += ixs.filter((i) => i.status === 'open').length;
            const fenced = this.fencedWithoutOutput(fold, r.runId);
            if (fenced.length) { await this.co.appendNow(threadId, { type: 'ui.chunk', runId: r.runId, chunks: fenced.map((toolCallId) => ({ type: 'tool-output-error', toolCallId, errorText: 'Interrupted: host restarted after this tool started executing; not re-executed.' }) as UIMessageChunk) }, fenced.length); report.fencedNotReExecuted += fenced.length; }
            continue;
          }
          // G5: the run cannot resume as a whole -> interrupt EVERY open interaction on it, with a visible reason on the tool part
          for (const i of ixs.filter((x) => x.status === 'open')) { await this.appendNow(threadId, { type: 'interaction.responded', interactionId: i.interactionId, decision: 'interrupted', reason: this.meta(i.toolName).transcript ? 'redacted input was never persisted' : 'run interrupted: another pending call had redacted input' }); report.interactions++; }
          await this.healRun(threadId, r.runId, REDACTED_RESTART_REASON);
          await this.appendNow(threadId, { type: 'run.finished', runId: r.runId, status: 'interrupted', error: 'host restart: redacted durable interaction' });
          report.redactedInterrupted++; report.runs++;
        }
      }
      const f2 = await this.fold(threadId);
      for (const i of Object.values(f2.interactions)) if (i.status === 'open' && !(i.durable && f2.runs[i.runId]?.status === 'suspended' && f2.runs[i.runId]?.depth === 0)) { await this.appendNow(threadId, { type: 'interaction.responded', interactionId: i.interactionId, decision: 'interrupted' }); report.interactions++; }
      for (const r of Object.values((await this.fold(threadId)).runs)) {
        const keep = r.status === 'suspended' && r.depth === 0 && Object.values((await this.fold(threadId)).interactions).some((i) => i.runId === r.runId && i.status === 'open');
        if (keep) continue;
        if (r.status === 'suspended' && r.depth === 0) {
          // every interaction answered before the crash but the resume leg never started: resumable, leave it for resumeAnswered()
          if (Object.values((await this.fold(threadId)).interactions).some((i) => i.runId === r.runId && i.status === 'answered' && i.durable)) continue;
        }
        if (r.status !== 'running' && r.status !== 'suspended') continue;
        await this.healRun(threadId, r.runId, 'Interrupted: host restarted before this tool finished.');
        await this.appendNow(threadId, { type: 'run.finished', runId: r.runId, status: 'interrupted', error: 'host restart' });
        report.runs++;
        if (r.background && r.parentThreadId) {
          await this.appendNow(r.parentThreadId, { type: 'child.terminal', childRunId: r.runId, childThreadId: threadId, status: 'interrupted', text: lastAssistantText(await this.fold(threadId), r.runId), background: true });
          report.childTerminals++;
        }
      }
    }
    return report;
  }
  private fencedWithoutOutput(fold: FoldState, runId: string): string[] {
    const out: string[] = [];
    for (const id of fold.runs[runId]?.messageIds ?? []) for (const p of (fold.messages[id]?.parts ?? []) as Array<Record<string, any>>) {
      if (fold.execStarted[p.toolCallId] && (p.state === 'approval-responded' || p.state === 'input-available')) out.push(p.toolCallId);
    }
    return out;
  }
}

/**
 * P-H: Mastra MessageHistory semantics — the last N STORED messages before the turn's own input, plus the turn itself.
 * cutoffId = the head when the run started (its trigger message); everything from it onward is the current turn.
 */
export function applyHistoryWindow(messages: UIMessage[], cutoffId: string | null, lastMessages: number): UIMessage[] {
  if (cutoffId === null) return messages;
  const idx = messages.findIndex((m) => m.id === cutoffId);
  if (idx < 0) throw new Error(`history window: trigger message ${cutoffId} is not in the model input`);
  const prior = messages.slice(0, idx);
  return [...prior.slice(Math.max(0, prior.length - lastMessages)), ...messages.slice(idx)];
}

function applyOverlay(messages: UIMessage[], overlay: RunCtx['overlay']) {
  for (const m of messages) for (const p of m.parts as Array<Record<string, any>>) {
    const o = typeof p.toolCallId === 'string' ? overlay.get(p.toolCallId) : undefined;
    if (!o) continue;
    if (o.input !== undefined) { p.input = o.input; if (p.rawInput !== undefined) p.rawInput = JSON.stringify(o.input); }
    if (o.output !== undefined && p.state === 'output-available') p.output = o.output;
    if (o.errorText !== undefined && p.state === 'output-error') p.errorText = o.errorText;
  }
}

export function userMessage(text: string, metadata?: Record<string, unknown>): UIMessage {
  return { id: nextId('u'), role: 'user', metadata, parts: [{ type: 'text', text }] } as UIMessage;
}
export function lastAssistantText(fold: FoldState, runId: string): string {
  const ids = fold.runs[runId]?.messageIds ?? [];
  const msg = ids.length ? fold.messages[ids[ids.length - 1]!] : undefined;
  return (msg?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}
