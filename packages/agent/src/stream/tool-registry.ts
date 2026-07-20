import { cloneJsonSafe } from './json';

export interface ToolCallControllerLike {
  argsText: { append: (text: string) => void };
  close: () => void;
  setResponse: (options: { result: unknown; isError: boolean }) => void;
}

export interface ToolRegistryEntry<TController extends ToolCallControllerLike> {
  controller: TController;
  name: string;
}

export interface ToolRegistry<TController extends ToolCallControllerLike> {
  byKey: Map<string, ToolRegistryEntry<TController>>;
  nameToKeys: Map<string, string[]>;
}

export function createToolRegistry<
  TController extends ToolCallControllerLike,
>(): ToolRegistry<TController> {
  return { byKey: new Map(), nameToKeys: new Map() };
}

export function startToolCall<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  name: string,
  payload: unknown,
  controller: TController
): void {
  const key = extractCallId(payload) ?? nextSyntheticToolKey(name);
  registerToolController(registry, key, name, controller);
  if (payload === undefined || payload === null) {
    return;
  }
  try {
    controller.argsText.append(JSON.stringify(cloneJsonSafe(payload), null, 2));
  } catch {
    controller.argsText.append(String(payload));
  }
}

export function recordToolProgress<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  name: string,
  payload: unknown
): string | undefined {
  const resolved = resolveToolEntry(registry, name, payload);
  if (!resolved) {
    return;
  }
  const [, entry] = resolved;
  const line = formatProgressLine(payload);
  if (!line) {
    return;
  }
  entry.controller.argsText.append(`\n${line}`);
  return line;
}

export function completeToolCall<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  name: string,
  status: string,
  payload: unknown
): void {
  const resolved = resolveToolEntry(registry, name, payload);
  if (!resolved) {
    return;
  }
  const [key, entry] = resolved;
  entry.controller.setResponse({
    isError: status === 'error',
    result: cloneJsonSafe(payload ?? null),
  });
  entry.controller.close();
  releaseToolEntry(registry, key);
}

/**
 * Clear all entries from the registry (for cleanup on abort/teardown).
 */
export function clearToolRegistry<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>
): void {
  registry.byKey.clear();
  registry.nameToKeys.clear();
}

function extractCallId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const record = payload as Record<string, unknown>;
  const candidates = [record['callId'], record['toolCallId'], record['id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  const call = record['call'];
  if (call && typeof call === 'object') {
    const nestedId = (call as Record<string, unknown>)['id'];
    if (typeof nestedId === 'string' && nestedId.trim().length > 0) {
      return nestedId;
    }
  }
  return;
}

const nextSyntheticToolKey = (() => {
  let counter = 0;
  return (name: string): string => {
    counter += 1;
    return `${name}#${Date.now()}#${counter}`;
  };
})();

function registerToolController<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  key: string,
  name: string,
  controller: TController
): void {
  registry.byKey.set(key, { controller, name });
  const queue = registry.nameToKeys.get(name) ?? [];
  queue.push(key);
  registry.nameToKeys.set(name, queue);
}

function resolveToolEntry<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  name: string,
  payload: unknown
): [string, ToolRegistryEntry<TController>] | undefined {
  const key = resolveToolKey(registry, name, payload);
  if (!key) {
    return;
  }
  const entry = registry.byKey.get(key);
  if (!entry) {
    return;
  }
  return [key, entry];
}

function resolveToolKey<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  name: string,
  payload: unknown
): string | undefined {
  const callId = extractCallId(payload);
  if (callId && registry.byKey.has(callId)) {
    return callId;
  }
  const queue = registry.nameToKeys.get(name);
  if (!queue || queue.length === 0) {
    return;
  }
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const candidate = queue[i];
    if (typeof candidate === 'string' && registry.byKey.has(candidate)) {
      return candidate;
    }
  }
  return;
}

function releaseToolEntry<TController extends ToolCallControllerLike>(
  registry: ToolRegistry<TController>,
  key: string
): void {
  const entry = registry.byKey.get(key);
  if (!entry) {
    return;
  }
  registry.byKey.delete(key);
  const queue = registry.nameToKeys.get(entry.name);
  if (!queue) {
    return;
  }
  const idx = queue.lastIndexOf(key);
  if (idx >= 0) {
    queue.splice(idx, 1);
  }
  if (queue.length === 0) {
    registry.nameToKeys.delete(entry.name);
  }
}

function formatProgressLine(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const record = payload as Record<string, unknown>;
  const step = typeof record['step'] === 'string' ? record['step'] : undefined;
  const percent =
    typeof record['percent'] === 'number' && Number.isFinite(record['percent'])
      ? record['percent']
      : undefined;
  const note = typeof record['note'] === 'string' ? record['note'] : undefined;
  const parts: string[] = [];
  parts.push(step ?? 'Progress');
  if (percent !== undefined) {
    parts.push(`(${Math.round(percent)}%)`);
  }
  if (note) {
    parts.push(`— ${note}`);
  }
  return parts.join(' ');
}
