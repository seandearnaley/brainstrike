// Pure, JSON-serializable fold of the run_events log.
// The per-run UI reducer mirrors ai@7.0.126 processUIMessageStream semantics, but keeps
// active-part state as INDICES (serializable) so a fold snapshot at any seq can be resumed.
import { isToolUIPart, parsePartialJson, type UIMessage, type UIMessageChunk } from 'ai';
import type { BrainstrikeStepUsage, Decision, HostEvent, InteractionKind, RunStatus } from './events.js';
import type { LogRow } from './log.js';

type AnyPart = Record<string, any>;
export interface RunReducer {
  message: UIMessage;
  activeText: Record<string, number>;
  activeReasoning: Record<string, number>;
  partialToolCalls: Record<string, { text: string; toolName: string; index: number; dynamic?: boolean; title?: string; toolMetadata?: unknown }>;
}
export interface RunInfo { runId: string; parentRunId: string | null; depth: number; status: 'running' | 'suspended' | RunStatus; messageIds: string[]; trigger: string; background?: boolean; parentThreadId?: string; provider?: string; sdkProvider?: string; modelId?: string; label?: string; sessionId?: string; legs: number; historyCutoffId?: string | null; usage: BrainstrikeStepUsage[] }
export interface InteractionInfo { interactionId: string; runId: string; toolCallId: string; toolName: string; input: unknown; status: 'open' | 'answered' | 'interrupted'; decision?: Decision; kind?: InteractionKind; durable?: boolean; approvalId?: string; answer?: unknown }
export interface FoldState {
  seq: number;
  order: string[]; // message ids in first-appearance order
  messages: Record<string, UIMessage>;
  reducers: Record<string, RunReducer>; // keyed by runId (current segment)
  runs: Record<string, RunInfo>;
  interactions: Record<string, InteractionInfo>;
  childTerminals: Array<Extract<HostEvent, { type: 'child.terminal' }> & { seq: number }>;
  om: Extract<HostEvent, { type: 'om.observations' }> | null;
  lastUserSeq: number;
  createdAt: Record<string, number>; // message id -> first-appearance time (from the log)
  /** branch structure: message id -> parent message id (null = root); head = leaf of the active branch */
  parentOf: Record<string, string | null>;
  head: string | null;
  /** toolCallIds whose durable effect has started (exactly-once fence) */
  execStarted: Record<string, { runId: string; toolName: string }>;
  /** B4: committed model views for tool results whose logged output is a transcript projection (by toolCallId) */
  modelOutputs: Record<string, unknown>;
}

export const emptyFold = (): FoldState => ({ seq: 0, order: [], messages: {}, reducers: {}, runs: {}, interactions: {}, childTerminals: [], om: null, lastUserSeq: 0, createdAt: {}, parentOf: {}, head: null, execStarted: {}, modelOutputs: {} });

const currentStepStart = (parts: AnyPart[]) => { let i = parts.length - 1; while (i >= 0 && parts[i].type !== 'step-start') i--; return i + 1; };
const staticName = (p: AnyPart) => p.type.slice(5);

function setToolPart(st: RunReducer, o: AnyPart, existing?: AnyPart) {
  const parts = st.message.parts as AnyPart[];
  const dyn = o.dynamic === true;
  const part = existing ?? parts.slice(currentStepStart(parts)).find((p) => (dyn ? p.type === 'dynamic-tool' : isToolUIPart(p as any) && p.type !== 'dynamic-tool') && p.toolCallId === o.toolCallId);
  const isResult = o.state === 'output-available' || o.state === 'output-error';
  if (part) {
    part.state = o.state;
    if (dyn) part.toolName = o.toolName;
    part.input = o.input; part.output = o.output; part.errorText = o.errorText; part.rawInput = o.rawInput; part.preliminary = o.preliminary;
    if (o.title !== undefined) part.title = o.title;
    if (o.toolMetadata !== undefined) part.toolMetadata = o.toolMetadata;
    part.providerExecuted = o.providerExecuted ?? part.providerExecuted;
    if (o.providerMetadata != null) { if (isResult) part.resultProviderMetadata = o.providerMetadata; else part.callProviderMetadata = o.providerMetadata; }
    return;
  }
  const base: AnyPart = dyn
    ? { type: 'dynamic-tool', toolName: o.toolName, toolCallId: o.toolCallId, state: o.state, input: o.input, output: o.output, errorText: o.errorText, preliminary: o.preliminary, providerExecuted: o.providerExecuted, title: o.title }
    : { type: `tool-${o.toolName}`, toolCallId: o.toolCallId, state: o.state, title: o.title };
  if (o.toolMetadata !== undefined) base.toolMetadata = o.toolMetadata;
  if (!dyn) Object.assign(base, { input: o.input, output: o.output, rawInput: o.rawInput, errorText: o.errorText, providerExecuted: o.providerExecuted, preliminary: o.preliminary });
  if (o.providerMetadata != null) base[isResult ? 'resultProviderMetadata' : 'callProviderMetadata'] = o.providerMetadata;
  parts.push(base);
}

function findTool(st: RunReducer, toolCallId: string): AnyPart {
  const parts = st.message.parts as AnyPart[];
  const cur = parts.slice(currentStepStart(parts)).find((p) => isToolUIPart(p as any) && p.toolCallId === toolCallId);
  const found = cur ?? [...parts].reverse().find((p) => isToolUIPart(p as any) && p.toolCallId === toolCallId);
  if (!found) throw new Error(`fold: no tool invocation for ${toolCallId}`);
  return found;
}

/** Apply one UIMessageChunk (readUIMessageStream semantics). */
export async function applyChunk(st: RunReducer, c: UIMessageChunk): Promise<void> {
  const parts = st.message.parts as AnyPart[];
  switch (c.type) {
    case 'text-start': st.activeText[c.id] = parts.push({ type: 'text', text: '', providerMetadata: c.providerMetadata, state: 'streaming' }) - 1; return;
    case 'text-delta': { const p = parts[st.activeText[c.id]!]; if (!p) throw new Error(`fold: text-delta for missing ${c.id}`); p.text += c.delta; p.providerMetadata = c.providerMetadata ?? p.providerMetadata; return; }
    case 'text-end': { const p = parts[st.activeText[c.id]!]; if (!p) throw new Error(`fold: text-end for missing ${c.id}`); p.state = 'done'; p.providerMetadata = c.providerMetadata ?? p.providerMetadata; delete st.activeText[c.id]; return; }
    case 'reasoning-start': st.activeReasoning[c.id] = parts.push({ type: 'reasoning', id: c.id, text: '', providerMetadata: c.providerMetadata, state: 'streaming' }) - 1; return;
    case 'reasoning-delta': { const p = parts[st.activeReasoning[c.id]!]; if (!p) throw new Error('fold: reasoning-delta missing'); p.text += c.delta; p.providerMetadata = c.providerMetadata ?? p.providerMetadata; return; }
    case 'reasoning-end': { const p = parts[st.activeReasoning[c.id]!]; if (!p) throw new Error('fold: reasoning-end missing'); p.providerMetadata = c.providerMetadata ?? p.providerMetadata; p.state = 'done'; delete st.activeReasoning[c.id]; return; }
    case 'custom': parts.push({ type: 'custom', kind: c.kind, providerMetadata: c.providerMetadata }); return;
    case 'file': case 'reasoning-file': parts.push({ type: c.type, mediaType: c.mediaType, url: c.url, ...(c.providerMetadata != null ? { providerMetadata: c.providerMetadata } : {}) }); return;
    case 'source-url': parts.push({ type: 'source-url', sourceId: c.sourceId, url: c.url, title: c.title, providerMetadata: c.providerMetadata }); return;
    case 'source-document': parts.push({ type: 'source-document', sourceId: c.sourceId, mediaType: c.mediaType, title: c.title, filename: c.filename, providerMetadata: c.providerMetadata }); return;
    case 'tool-input-start': {
      const idx = parts.slice(currentStepStart(parts)).filter((p) => isToolUIPart(p as any) && p.type !== 'dynamic-tool').length;
      st.partialToolCalls[c.toolCallId] = { text: '', toolName: c.toolName, index: idx, dynamic: c.dynamic, title: c.title, toolMetadata: c.toolMetadata };
      setToolPart(st, { toolCallId: c.toolCallId, toolName: c.toolName, state: 'input-streaming', input: undefined, providerExecuted: c.providerExecuted, title: c.title, toolMetadata: c.toolMetadata, providerMetadata: c.providerMetadata, dynamic: c.dynamic });
      return;
    }
    case 'tool-input-delta': {
      const pc = st.partialToolCalls[c.toolCallId]; if (!pc) throw new Error('fold: tool-input-delta missing');
      pc.text += c.inputTextDelta;
      const { value } = await parsePartialJson(pc.text);
      setToolPart(st, { toolCallId: c.toolCallId, toolName: pc.toolName, state: 'input-streaming', input: value, rawInput: pc.text, title: pc.title, toolMetadata: pc.toolMetadata, dynamic: pc.dynamic });
      return;
    }
    case 'tool-input-available': setToolPart(st, { ...c, state: 'input-available' }); return;
    case 'tool-input-error': {
      const ex = parts.slice(currentStepStart(parts)).find((p) => isToolUIPart(p as any) && p.toolCallId === c.toolCallId);
      setToolPart(st, { toolCallId: c.toolCallId, toolName: c.toolName, state: 'output-error', input: c.input, errorText: c.errorText, providerExecuted: c.providerExecuted, providerMetadata: c.providerMetadata, toolMetadata: c.toolMetadata, dynamic: ex ? ex.type === 'dynamic-tool' : !!c.dynamic });
      return;
    }
    case 'tool-approval-request': {
      const t = findTool(st, c.toolCallId); const a = c as AnyPart;
      t.state = 'approval-requested';
      t.approval = { id: a.approvalId, ...(a.approvalDescriptor != null ? { descriptor: a.approvalDescriptor } : {}), ...(Object.prototype.hasOwnProperty.call(a, 'inputSchemaInput') ? { inputSchemaInput: a.inputSchemaInput } : {}), ...(a.reason != null ? { requestReason: a.reason } : {}), ...(a.isAutomatic === true ? { isAutomatic: true } : {}), ...(a.signature != null ? { signature: a.signature } : {}) };
      return;
    }
    case 'tool-approval-response': {
      const a = c as AnyPart;
      const t = (st.message.parts as AnyPart[]).find((p) => isToolUIPart(p as any) && p.approval?.id === a.approvalId);
      if (!t) throw new Error(`fold: no tool invocation for approval ${a.approvalId}`);
      t.state = 'approval-responded';
      t.approval = { ...(t.approval ?? { id: a.approvalId }), id: a.approvalId, approved: a.approved, ...(a.reason != null ? { reason: a.reason } : {}) };
      if (a.providerExecuted != null) t.providerExecuted = a.providerExecuted;
      if (a.providerMetadata != null) t.callProviderMetadata = a.providerMetadata;
      return;
    }
    case 'tool-output-denied': findTool(st, c.toolCallId).state = 'output-denied'; return;
    case 'tool-output-available': {
      const t = findTool(st, c.toolCallId); const dyn = t.type === 'dynamic-tool';
      setToolPart(st, { toolCallId: c.toolCallId, toolName: dyn ? t.toolName : staticName(t), state: 'output-available', input: t.input, output: c.output, preliminary: c.preliminary, providerExecuted: c.providerExecuted, providerMetadata: c.providerMetadata, title: t.title, toolMetadata: c.toolMetadata ?? t.toolMetadata, dynamic: dyn }, t);
      return;
    }
    case 'tool-output-error': {
      const t = findTool(st, c.toolCallId); const dyn = t.type === 'dynamic-tool';
      setToolPart(st, { toolCallId: c.toolCallId, toolName: dyn ? t.toolName : staticName(t), state: 'output-error', input: t.input, ...(dyn ? {} : { rawInput: t.rawInput }), errorText: c.errorText, providerExecuted: c.providerExecuted, providerMetadata: c.providerMetadata, title: t.title, toolMetadata: c.toolMetadata ?? t.toolMetadata, dynamic: dyn }, t);
      return;
    }
    case 'start-step': parts.push({ type: 'step-start' }); return;
    case 'finish-step': return;
    case 'reset-step': {
      const from = currentStepStart(parts);
      st.activeText = {}; st.activeReasoning = {}; st.partialToolCalls = {};
      parts.splice(from, parts.length - from); return;
    }
    case 'start': if (c.messageId != null) st.message.id = c.messageId; mergeMeta(st, c.messageMetadata); return;
    case 'finish': case 'message-metadata': mergeMeta(st, c.messageMetadata); return;
    case 'error': case 'abort': return;
    default: {
      const d = c as AnyPart;
      if (typeof d.type === 'string' && d.type.startsWith('data-')) {
        if (d.transient) return;
        const ex = d.id != null ? parts.find((p) => p.type === d.type && p.id === d.id) : undefined;
        if (ex) ex.data = d.data; else parts.push({ ...d });
      }
    }
  }
}

function mergeMeta(st: RunReducer, meta: unknown) {
  if (meta == null) return;
  const cur = st.message.metadata as Record<string, unknown> | undefined;
  st.message.metadata = cur != null ? deepMerge(cur, meta as Record<string, unknown>) : meta;
}
function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  return out;
}

export const newReducer = (messageId: string): RunReducer => ({ message: { id: messageId, metadata: undefined, role: 'assistant', parts: [] } as UIMessage, activeText: {}, activeReasoning: {}, partialToolCalls: {} });

/** Fold rows into state (mutates + returns state). Resumable from any snapshot. */
export async function foldRows(state: FoldState, rows: LogRow[]): Promise<FoldState> {
  for (const { seq, event: e, ts } of rows) {
    state.seq = seq;
    state.createdAt ??= {};
    switch (e.type) {
      case 'ui.message': {
        state.parentOf ??= {}; state.execStarted ??= {};
        state.messages[e.message.id] = structuredClone(e.message);
        state.order.push(e.message.id);
        state.parentOf[e.message.id] = e.parentId !== undefined ? e.parentId : state.head;
        state.head = e.message.id;
        state.createdAt[e.message.id] = ts ?? seq;
        state.lastUserSeq = seq;
        // A message landing mid-run splits that run's assistant message (keeps model input chronological).
        for (const r of Object.values(state.runs)) if (r.status === 'running' && state.reducers[r.runId]?.message.parts.length) splitSegment(state, r);
        break;
      }
      case 'run.segment': { const r = state.runs[e.runId]; if (r && state.reducers[r.runId]?.message.parts.length) splitSegment(state, r); break; }
      case 'run.started':
        state.parentOf ??= {}; state.execStarted ??= {};
        state.runs[e.runId] = { runId: e.runId, parentRunId: e.parentRunId, depth: e.depth, status: 'running', messageIds: [e.messageId], trigger: e.trigger, background: e.background, parentThreadId: e.parentThreadId, provider: e.provider, sdkProvider: e.sdkProvider, modelId: e.modelId, label: e.label, sessionId: e.sessionId, legs: 1, historyCutoffId: e.historyCutoffId, usage: [] };
        state.reducers[e.runId] = newReducer(e.messageId);
        state.parentOf[e.messageId] = e.parentMessageId !== undefined ? e.parentMessageId : state.head;
        state.head = e.messageId;
        break;
      case 'run.suspended': state.runs[e.runId]!.status = 'suspended'; break;
      case 'run.resumed': { const r = state.runs[e.runId]!; r.status = 'running'; r.legs = e.leg; break; }
      case 'tool.exec.started': state.execStarted[e.toolCallId] = { runId: e.runId, toolName: e.toolName }; break;
      case 'run.usage': state.runs[e.runId]!.usage.push(e.usage); break;
      case 'thread.head': state.head = e.headId; break;
      case 'ui.chunk': {
        const r = state.reducers[e.runId]!; const run = state.runs[e.runId]!;
        for (const c of e.chunks) {
          await applyChunk(r, c);
          // 'start' may rename the first segment's id
          if (c.type === 'start' && c.messageId != null && run.messageIds.length === 1) run.messageIds[0] = c.messageId;
        }
        const id = r.message.id;
        if (r.message.parts.length > 0 || state.messages[id]) {
          if (!state.messages[id]) { state.order.push(id); state.createdAt[id] = ts ?? seq; }
          state.messages[id] = r.message;
        }
        break;
      }
      case 'interaction.requested': state.interactions[e.interactionId] = { ...e, status: 'open' } as InteractionInfo; delete (state.interactions[e.interactionId] as any).type; break;
      case 'interaction.responded': {
        const i = state.interactions[e.interactionId]!;
        i.status = e.decision === 'interrupted' ? 'interrupted' : 'answered';
        if (e.decision !== 'interrupted') i.decision = e.decision;
        if (e.answer !== undefined) i.answer = e.answer;
        break;
      }
      case 'run.finished': state.runs[e.runId]!.status = e.status; break;
      case 'child.terminal': state.childTerminals.push({ ...e, seq }); break;
      case 'om.observations': state.om = e; break;
      case 'tool.model-output': (state.modelOutputs ??= {})[e.toolCallId] = e.modelOutput; break;
    }
  }
  return state;
}

function splitSegment(state: FoldState, r: RunInfo) {
  const segId = `${r.messageIds[0]}~${r.messageIds.length}`;
  r.messageIds.push(segId);
  state.reducers[r.runId] = newReducer(segId);
  state.parentOf[segId] = state.head;
  state.head = segId;
}

/** Active branch: walk parents from the head (ids without parts yet are skipped), root first. */
export function activePath(s: FoldState, headId: string | null = s.head): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let id = headId; id != null; id = s.parentOf[id] ?? null) {
    if (seen.has(id)) throw new Error(`fold: parent cycle at ${id}`);
    seen.add(id);
    if (s.messages[id]) out.push(id);
  }
  return out.reverse();
}
/** The model/UI history = the active branch (linear threads: identical to log order). */
export const foldMessages = (s: FoldState): UIMessage[] => activePath(s).map((id) => s.messages[id]!);
/** Every message with its parent (all branches) — input for assistant-ui's messageRepository. */
export const foldTree = (s: FoldState): Array<{ message: UIMessage; parentId: string | null }> => {
  const nearest = (id: string | null): string | null => { while (id != null && !s.messages[id]) id = s.parentOf[id] ?? null; return id; };
  return s.order.filter((id) => s.messages[id]).map((id) => ({ message: s.messages[id]!, parentId: nearest(s.parentOf[id] ?? null) }));
};
