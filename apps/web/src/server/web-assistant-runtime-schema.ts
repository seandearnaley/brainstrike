import { OPENAI_REASONING_EFFORT_VALUES, type RuntimeData } from '@brainstrike/agent/hosted-web';
import { z } from 'zod';

const MAX_COUNT = 100_000_000;
const MAX_ID_CHARS = 512;
const MAX_JSON_COLLECTION_ITEMS = 1000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 5000;
const MAX_JSON_OBJECT_KEYS = 100;
const MAX_LIST_ITEMS = 5000;
const MAX_PATH_CHARS = 4096;
const MAX_TEXT_CHARS = 4096;

const countSchema = z.number().int().min(0).max(MAX_COUNT);
const finiteNumberSchema = z.number().finite().min(-MAX_COUNT).max(MAX_COUNT);
const idSchema = z.string().min(1).max(MAX_ID_CHARS);
const pathSchema = z.string().min(1).max(MAX_PATH_CHARS);
const textSchema = z.string().max(MAX_TEXT_CHARS);
// Keep in sync with desktop's ALLOWED_WORKSPACE_INDEXING_MODES.
const workspaceIndexingModeSchema = z.literal('root-folder-cache');

const queueProgressSchema = z
  .object({
    failed: countSchema,
    lastError: textSchema.nullable().optional(),
    pending: countSchema,
    processed: countSchema,
    totalQueued: countSchema,
  })
  .strict();

const workspaceIndexStatusSchema = z.enum([
  'blocked',
  'disabled',
  'idle',
  'paused',
  'recovering',
  'waiting',
  'scanning',
  'importing',
  'chunking',
  'embedding',
  'error',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

interface PendingJsonValue {
  depth: number;
  value: unknown;
}

function isBoundedJsonScalar(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_TEXT_CHARS;
  }
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COUNT;
}

function appendJsonChildren(
  current: PendingJsonValue,
  pending: PendingJsonValue[],
  seen: WeakSet<object>
): boolean {
  if (!(current.value && typeof current.value === 'object') || seen.has(current.value)) {
    return false;
  }
  seen.add(current.value);

  if (Array.isArray(current.value)) {
    if (current.value.length > MAX_JSON_COLLECTION_ITEMS) {
      return false;
    }
    for (const item of current.value) {
      pending.push({ depth: current.depth + 1, value: item });
    }
    return true;
  }
  if (!isPlainRecord(current.value)) {
    return false;
  }
  const entries = Object.entries(current.value);
  if (
    entries.length > MAX_JSON_OBJECT_KEYS ||
    entries.some(([key]) => key.length === 0 || key.length > MAX_ID_CHARS)
  ) {
    return false;
  }
  for (const [, item] of entries) {
    pending.push({ depth: current.depth + 1, value: item });
  }
  return true;
}

function isBoundedJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false;
  }

  const seen = new WeakSet<object>();
  const pending: PendingJsonValue[] = [{ depth: 0, value }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      return false;
    }
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      return false;
    }
    if (isBoundedJsonScalar(current.value)) {
      continue;
    }
    if (!appendJsonChildren(current, pending, seen)) {
      return false;
    }
  }
  return true;
}

const FORWARDED_REQUEST_SCHEMAS = {
  mainRootId: idSchema,
  mainRootPath: pathSchema,
  projectId: idSchema,
  selectionFolderId: idSchema,
  workspaceIndexBlockedReason: idSchema.nullable(),
  workspaceIndexEmbeddingSetId: idSchema,
  workspaceIndexingEnabled: z.boolean(),
  workspaceIndexingMode: workspaceIndexingModeSchema,
  workspaceIndexingPaused: z.boolean(),
  workspaceIndexLastError: textSchema.nullable(),
  workspaceIndexQueueProgress: queueProgressSchema.nullable(),
  workspaceIndexStatusState: workspaceIndexStatusSchema,
  workspaceRootPath: pathSchema,
} satisfies Partial<Record<keyof RuntimeData, z.ZodType>>;

type ForwardedRequestField = keyof typeof FORWARDED_REQUEST_SCHEMAS;
type ForwardedRuntimeData = Partial<Pick<RuntimeData, ForwardedRequestField>>;

const FORWARDED_REQUEST_FIELDS = Object.keys(FORWARDED_REQUEST_SCHEMAS) as ForwardedRequestField[];
const ACCEPTED_IGNORED_WIRE_SCHEMAS = {
  agentLoop: z
    .object({
      inputTokenLimit: z.number().int().positive().max(MAX_COUNT).optional(),
      maxSteps: z.number().int().positive().max(MAX_COUNT).optional(),
    })
    .strict(),
  enabledNativeToolIds: z.array(idSchema).max(MAX_LIST_ITEMS),
  mcpEnabled: z.boolean(),
  model: idSchema,
  modelSettings: z
    .object({
      frequencyPenalty: finiteNumberSchema.optional(),
      maxOutputTokens: z.number().int().positive().max(MAX_COUNT).optional(),
      presencePenalty: finiteNumberSchema.optional(),
      temperature: finiteNumberSchema.optional(),
      topP: finiteNumberSchema.optional(),
    })
    .strict(),
  provider: idSchema,
  providerOptions: z.custom<Record<string, unknown>>(isBoundedJsonObject),
  // Accepted for shared desktop/web wire compatibility but ignored: Hosted Web
  // owns model/generation policy server-side and exposes no explicit effort UI.
  // Derived, not re-listed: the field is typed `OpenAiReasoningEffort`, so the
  // enum that guards it must be the same declaration and not a copy that can
  // drift narrower (rejecting an offered effort) or wider (admitting one the
  // provider rejects).
  requestedReasoningEffort: z.enum(OPENAI_REASONING_EFFORT_VALUES),
  transportImageElision: z
    .object({
      elidedImageBytes: countSchema,
      elidedImageCount: countSchema,
      keptImageBytes: countSchema,
      strategy: z.literal('newest-first-combined-image-budget'),
      unmeasurableImageCount: countSchema.optional(),
    })
    .strict()
    .refine(
      (metadata) =>
        metadata.unmeasurableImageCount === undefined ||
        metadata.unmeasurableImageCount <= metadata.elidedImageCount
    ),
} satisfies Partial<Record<keyof RuntimeData, z.ZodType>>;

type AcceptedIgnoredWireField = keyof typeof ACCEPTED_IGNORED_WIRE_SCHEMAS;
const ACCEPTED_IGNORED_WIRE_FIELDS = Object.keys(
  ACCEPTED_IGNORED_WIRE_SCHEMAS
) as AcceptedIgnoredWireField[];
const ACCEPTED_WIRE_FIELDS = new Set<string>([
  ...FORWARDED_REQUEST_FIELDS,
  ...ACCEPTED_IGNORED_WIRE_FIELDS,
]);

export type WebAssistantRuntimeDataParseResult =
  | { data: ForwardedRuntimeData; success: true }
  | { field: string; reason: 'invalid' | 'unsupported'; success: false };

export function parseWebAssistantRuntimeData(data: unknown): WebAssistantRuntimeDataParseResult {
  if (data === undefined) {
    return { data: {}, success: true };
  }
  if (!(data && typeof data === 'object' && !Array.isArray(data))) {
    return { field: 'data', reason: 'invalid', success: false };
  }

  const record = data as Record<string, unknown>;
  const unsupportedField = Object.keys(record).find((field) => !ACCEPTED_WIRE_FIELDS.has(field));
  if (unsupportedField) {
    return { field: unsupportedField, reason: 'unsupported', success: false };
  }

  const parsed: Record<string, unknown> = {};
  for (const field of FORWARDED_REQUEST_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      continue;
    }
    const result = FORWARDED_REQUEST_SCHEMAS[field].safeParse(record[field]);
    if (!result.success) {
      return { field, reason: 'invalid', success: false };
    }
    parsed[field] = result.data;
  }
  for (const field of ACCEPTED_IGNORED_WIRE_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      continue;
    }
    if (!ACCEPTED_IGNORED_WIRE_SCHEMAS[field].safeParse(record[field]).success) {
      return { field, reason: 'invalid', success: false };
    }
  }
  return { data: parsed as ForwardedRuntimeData, success: true };
}
