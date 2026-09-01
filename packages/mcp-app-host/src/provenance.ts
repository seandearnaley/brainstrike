import type { MCP_APPS_MIME_TYPE } from './capabilities.js';
import { parseMcpAppJsonRecord, parseMcpAppRequestId } from './messages.js';
import {
  type McpAppResourceMeta,
  type McpAppResourceUri,
  type McpAppToolMeta,
  type McpAppToolVisibility,
  parseMcpAppMimeType,
  parseMcpAppResourceMeta,
  parseMcpAppResourceUri,
  parseMcpAppToolMeta,
} from './metadata.js';
import {
  expectEncodedSize,
  expectExactKeys,
  expectRecord,
  MCP_APP_MAX_MESSAGE_BYTES,
  type UnknownRecord,
} from './validation.js';

const MAX_SERVER_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_RESOURCE_BYTES = 1024 * 1024;

export type McpAppAudience = 'app' | 'model';

export interface McpAppGeneration {
  readonly generation: number;
  readonly serverId: string;
}

export interface McpAppOwnedTool extends McpAppGeneration {
  readonly name: string;
  readonly ui: McpAppToolMeta;
}

export interface McpAppOwnedResource extends McpAppGeneration {
  readonly html: string;
  readonly meta?: McpAppResourceMeta;
  readonly mimeType: typeof MCP_APPS_MIME_TYPE;
  readonly source: 'blob' | 'text';
  readonly toolName: string;
  readonly uri: McpAppResourceUri;
}

export interface McpAppToolCall extends McpAppGeneration {
  readonly audience: McpAppAudience;
  readonly id: number | string;
  readonly input: Readonly<UnknownRecord>;
  readonly toolName: string;
}

export interface McpAppOwnedToolResult extends McpAppGeneration {
  /** The audience that issued the call; a settled result stays bound to it. */
  readonly audience: McpAppAudience;
  readonly id: number | string;
  readonly result: Readonly<UnknownRecord>;
  readonly toolName: string;
}

interface GenerationState {
  active: boolean;
  readonly handle: McpAppGeneration;
  readonly pendingCallIds: Set<string>;
  readonly toolNames: Set<string>;
  readonly tools: McpAppOwnedTool[];
}

interface ToolState {
  readonly generation: GenerationState;
  readonly visibility: ReadonlySet<McpAppToolVisibility>;
}

interface CallState {
  readonly generation: GenerationState;
  settled: boolean;
}

function parseGeneration(value: unknown): McpAppGeneration {
  const label = 'MCP Apps server generation';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['generation', 'serverId'], ['generation', 'serverId'], label);
  const serverId = record['serverId'];
  if (
    typeof serverId !== 'string' ||
    serverId.length === 0 ||
    serverId.length > MAX_SERVER_ID_LENGTH ||
    serverId.trim() !== serverId
  ) {
    throw new TypeError(`${label}.serverId must contain 1 to ${MAX_SERVER_ID_LENGTH} characters`);
  }
  const generation = record['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(`${label}.generation must be a non-negative safe integer`);
  }
  return Object.freeze({ generation, serverId });
}

function parseTool(value: unknown): { readonly name: string; readonly ui: McpAppToolMeta } {
  const label = 'MCP Apps discovered tool';
  const record = expectRecord(value, label);
  const name = record['name'];
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_TOOL_NAME_LENGTH ||
    name.trim() !== name
  ) {
    throw new TypeError(`${label}.name must contain 1 to ${MAX_TOOL_NAME_LENGTH} characters`);
  }
  const meta = expectRecord(record['_meta'], `${label}._meta`);
  if (!Object.hasOwn(meta, 'ui')) {
    throw new TypeError(`${label}._meta.ui is required`);
  }
  return Object.freeze({ name, ui: parseMcpAppToolMeta(meta['ui']) });
}

function parsePayloadRecord(value: unknown, label: string): Readonly<UnknownRecord> {
  const parsed = parseMcpAppJsonRecord(value, label);
  expectEncodedSize(parsed, MCP_APP_MAX_MESSAGE_BYTES, label);
  return parsed;
}

function requestIdKey(id: number | string): string {
  return `${typeof id}:${id}`;
}

// Base64 expands every 3 decoded bytes into 4 characters; this is the longest
// canonical encoding of MAX_RESOURCE_BYTES, so anything longer is oversized
// before any decoding work is spent on it.
const MAX_RESOURCE_BASE64_LENGTH = Math.ceil(MAX_RESOURCE_BYTES / 3) * 4;

function decodeBlob(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be bounded canonical base64`);
  }
  if (value.length > MAX_RESOURCE_BASE64_LENGTH) {
    throw new TypeError(`${label} exceeds ${MAX_RESOURCE_BYTES} decoded bytes`);
  }
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${label} must be bounded canonical base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (error: unknown) {
    throw new TypeError(`${label} must be bounded canonical base64`, { cause: error });
  }
  if (binary.length > MAX_RESOURCE_BYTES) {
    throw new TypeError(`${label} exceeds ${MAX_RESOURCE_BYTES} decoded bytes`);
  }
  if (btoa(binary) !== value) {
    throw new TypeError(`${label} must be bounded canonical base64`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new TypeError(`${label} must decode to non-empty UTF-8`, { cause: error });
  }
  if (html.length === 0) {
    throw new TypeError(`${label} must decode to non-empty UTF-8`);
  }
  return html;
}

function parseResource(
  value: unknown,
  expectedUri: McpAppResourceUri
): Readonly<{
  html: string;
  meta?: McpAppResourceMeta;
  mimeType: typeof MCP_APPS_MIME_TYPE;
  source: 'blob' | 'text';
  uri: McpAppResourceUri;
}> {
  const label = 'MCP Apps resource content';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['_meta', 'blob', 'mimeType', 'text', 'uri'], ['mimeType', 'uri'], label);
  const uri = parseMcpAppResourceUri(record['uri']);
  if (uri !== expectedUri) {
    throw new TypeError(`${label}.uri does not match the associated tool resource`);
  }
  const mimeType = parseMcpAppMimeType(record['mimeType']);
  const hasText = Object.hasOwn(record, 'text');
  const hasBlob = Object.hasOwn(record, 'blob');
  if (hasText === hasBlob) {
    throw new TypeError(`${label} must contain exactly one of text or blob`);
  }
  let html: string;
  let source: 'blob' | 'text';
  if (hasText) {
    const text = record['text'];
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError(`${label}.text must be a non-empty string`);
    }
    html = text;
    // A UTF-8 byte count is never smaller than the UTF-16 length, so an
    // oversized string is rejected before the encoding pass allocates.
    if (
      html.length > MAX_RESOURCE_BYTES ||
      new TextEncoder().encode(html).byteLength > MAX_RESOURCE_BYTES
    ) {
      throw new TypeError(`${label}.text exceeds ${MAX_RESOURCE_BYTES} decoded bytes`);
    }
    source = 'text';
  } else {
    html = decodeBlob(record['blob'], `${label}.blob`);
    source = 'blob';
  }
  // `_meta` is the MCP extension bag: `ui` is parsed when present and any
  // namespaced sibling key is ignored, exactly as parseTool treats a tool's
  // `_meta`. An empty `_meta` degrades to no metadata.
  let meta: McpAppResourceMeta | undefined;
  if (record['_meta'] !== undefined) {
    const outerMeta = expectRecord(record['_meta'], `${label}._meta`);
    if (Object.hasOwn(outerMeta, 'ui')) {
      meta = parseMcpAppResourceMeta(outerMeta['ui']);
    }
  }
  return Object.freeze({ html, ...(meta === undefined ? {} : { meta }), mimeType, source, uri });
}

export class McpAppProvenanceAuthority {
  readonly #activeByServer = new Map<string, GenerationState>();
  readonly #calls = new WeakMap<McpAppToolCall, CallState>();
  readonly #generations = new WeakMap<McpAppGeneration, GenerationState>();
  readonly #latestByServer = new Map<string, number>();
  readonly #tools = new WeakMap<McpAppOwnedTool, ToolState>();

  openGeneration(value: unknown): McpAppGeneration {
    const handle = parseGeneration(value);
    const latest = this.#latestByServer.get(handle.serverId);
    if (latest !== undefined && handle.generation <= latest) {
      throw new TypeError('MCP Apps server generation must increase monotonically');
    }
    const previous = this.#activeByServer.get(handle.serverId);
    if (previous !== undefined) {
      previous.active = false;
    }
    const state: GenerationState = {
      active: true,
      handle,
      pendingCallIds: new Set<string>(),
      toolNames: new Set<string>(),
      tools: [],
    };
    this.#activeByServer.set(handle.serverId, state);
    this.#latestByServer.set(handle.serverId, handle.generation);
    this.#generations.set(handle, state);
    return handle;
  }

  registerTool(generation: McpAppGeneration, value: unknown): McpAppOwnedTool {
    const state = this.#requireActiveGeneration(generation);
    const parsed = parseTool(value);
    if (state.toolNames.has(parsed.name)) {
      throw new TypeError(
        `MCP Apps tool "${parsed.name}" is already registered in this generation`
      );
    }
    const tool = Object.freeze({ ...state.handle, name: parsed.name, ui: parsed.ui });
    const visibility = new Set<McpAppToolVisibility>(parsed.ui.visibility ?? ['model', 'app']);
    state.toolNames.add(parsed.name);
    state.tools.push(tool);
    this.#tools.set(tool, { generation: state, visibility });
    return tool;
  }

  toolsFor(generation: McpAppGeneration, audience: McpAppAudience): readonly McpAppOwnedTool[] {
    const state = this.#requireActiveGeneration(generation);
    if (audience !== 'app' && audience !== 'model') {
      throw new TypeError('MCP Apps tool audience must be "app" or "model"');
    }
    return Object.freeze(
      state.tools.filter((tool) => this.#tools.get(tool)?.visibility.has(audience) === true)
    );
  }

  resolveResource(
    generation: McpAppGeneration,
    tool: McpAppOwnedTool,
    value: unknown
  ): McpAppOwnedResource {
    const state = this.#requireActiveGeneration(generation);
    this.#requireOwnedTool(state, tool);
    const resourceUri = tool.ui.resourceUri;
    if (resourceUri === undefined) {
      throw new TypeError('MCP Apps tool has no associated resource URI');
    }
    return Object.freeze({
      ...parseResource(value, resourceUri),
      ...state.handle,
      toolName: tool.name,
    });
  }

  beginToolCall(
    generation: McpAppGeneration,
    tool: McpAppOwnedTool,
    value: unknown
  ): McpAppToolCall {
    const state = this.#requireActiveGeneration(generation);
    const toolState = this.#requireOwnedTool(state, tool);
    const label = 'MCP Apps tool call';
    const record = expectRecord(value, label);
    expectExactKeys(record, ['audience', 'id', 'input'], ['audience', 'id', 'input'], label);
    const audience = record['audience'];
    if (audience !== 'app' && audience !== 'model') {
      throw new TypeError(`${label}.audience must be "app" or "model"`);
    }
    if (!toolState.visibility.has(audience)) {
      throw new TypeError(`MCP Apps tool is not visible to ${audience}`);
    }
    const id = parseMcpAppRequestId(record['id'], label);
    const idKey = requestIdKey(id);
    if (state.pendingCallIds.has(idKey)) {
      throw new TypeError(`MCP Apps tool call id ${JSON.stringify(id)} is already pending`);
    }
    const call = Object.freeze({
      audience,
      ...state.handle,
      id,
      input: parsePayloadRecord(record['input'], `${label}.input`),
      toolName: tool.name,
    });
    state.pendingCallIds.add(idKey);
    this.#calls.set(call, { generation: state, settled: false });
    return call;
  }

  completeToolCall(
    generation: McpAppGeneration,
    call: McpAppToolCall,
    value: unknown
  ): McpAppOwnedToolResult {
    const state = this.#requireActiveGeneration(generation);
    const callState = this.#calls.get(call);
    if (callState?.generation !== state) {
      throw new TypeError('MCP Apps tool call does not belong to server generation');
    }
    if (callState.settled) {
      throw new TypeError('MCP Apps tool call is already settled');
    }
    const result = parsePayloadRecord(value, 'MCP Apps tool result');
    callState.settled = true;
    state.pendingCallIds.delete(requestIdKey(call.id));
    return Object.freeze({
      audience: call.audience,
      ...state.handle,
      id: call.id,
      result,
      toolName: call.toolName,
    });
  }

  cancelToolCall(generation: McpAppGeneration, call: McpAppToolCall): void {
    const state = this.#generations.get(generation);
    if (state === undefined) {
      throw new TypeError('MCP Apps server generation is not owned by this authority');
    }
    const callState = this.#calls.get(call);
    if (callState?.generation !== state) {
      throw new TypeError('MCP Apps tool call does not belong to server generation');
    }
    if (callState.settled) {
      throw new TypeError('MCP Apps tool call is already settled');
    }
    callState.settled = true;
    state.pendingCallIds.delete(requestIdKey(call.id));
  }

  /**
   * Explicit teardown (server disconnect without a replacement). The latest
   * generation number is deliberately kept so a reconnect must still open a
   * strictly greater generation: retirement never re-opens a replayable
   * generation.
   */
  retireGeneration(generation: McpAppGeneration): void {
    const state = this.#generations.get(generation);
    if (state === undefined) {
      throw new TypeError('MCP Apps server generation is not owned by this authority');
    }
    if (this.#activeByServer.get(generation.serverId) === state) {
      state.active = false;
      this.#activeByServer.delete(generation.serverId);
    }
  }

  #requireActiveGeneration(generation: McpAppGeneration): GenerationState {
    const state = this.#generations.get(generation);
    if (state === undefined) {
      throw new TypeError('MCP Apps server generation is not owned by this authority');
    }
    if (!state.active || this.#activeByServer.get(generation.serverId) !== state) {
      throw new TypeError('MCP Apps server generation is retired');
    }
    return state;
  }

  #requireOwnedTool(state: GenerationState, tool: McpAppOwnedTool): ToolState {
    const toolState = this.#tools.get(tool);
    if (toolState?.generation !== state) {
      throw new TypeError('MCP Apps tool does not belong to server generation');
    }
    return toolState;
  }
}
