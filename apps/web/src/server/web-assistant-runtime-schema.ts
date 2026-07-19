import type { RuntimeData } from '@brainstrike/agent';
import { z } from 'zod';

const MAX_COUNT = 100_000_000;
const MAX_ID_CHARS = 512;
const MAX_LIST_ITEMS = 5000;
const MAX_PATH_CHARS = 4096;
const MAX_POLICY_OVERRIDES = 1000;
const MAX_TEXT_CHARS = 4096;

const countSchema = z.number().int().min(0).max(MAX_COUNT);
const idSchema = z.string().min(1).max(MAX_ID_CHARS);
const pathSchema = z.string().min(1).max(MAX_PATH_CHARS);
const textSchema = z.string().max(MAX_TEXT_CHARS);
const permissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
const toolRiskSchema = z.enum(['read', 'edit', 'execute', 'mcp']);
// Keep in sync with desktop's ALLOWED_WORKSPACE_INDEXING_MODES.
const workspaceIndexingModeSchema = z.literal('root-folder-cache');

const workspaceRangeSchema = z
  .object({
    approxTokens: countSchema.nullable().optional(),
    endLine: countSchema,
    isActive: z.boolean().optional(),
    startLine: countSchema,
  })
  .strict()
  .refine((range) => range.endLine >= range.startLine);

const workspaceFileSchema = z
  .object({
    approxTokens: countSchema.nullable().optional(),
    outputApproxTokens: countSchema.nullable().optional(),
    path: pathSchema,
    ranges: z.array(workspaceRangeSchema).max(MAX_LIST_ITEMS).optional(),
    rootDisplayName: idSchema.optional(),
    rootId: idSchema.optional(),
  })
  .strict();

const workspaceContextSchema = z
  .object({
    files: z.array(workspaceFileSchema).max(MAX_LIST_ITEMS).optional(),
    includeProjectTree: z.boolean().optional(),
    projectTreeApproxTokens: countSchema.nullable().optional(),
    projectTreeTokenCountLoading: z.boolean().optional(),
    selectedOutputApproxTokens: countSchema.nullable().optional(),
    selectedSourceApproxTokens: countSchema.nullable().optional(),
    tokenBudget: z.number().int().positive().max(MAX_COUNT).optional(),
  })
  .strict();

const permissionPoliciesSchema = z
  .object({
    edit: permissionDecisionSchema,
    execute: permissionDecisionSchema,
    mcp: permissionDecisionSchema,
    read: permissionDecisionSchema,
  })
  .strict();

const permissionOverridesSchema = z
  .record(idSchema, permissionDecisionSchema)
  .refine((overrides) => Object.keys(overrides).length <= MAX_POLICY_OVERRIDES);

const permissionPolicyRequestSchema = z
  .object({
    enforce: z.boolean().optional(),
    perToolOverrides: permissionOverridesSchema.optional(),
    policies: permissionPoliciesSchema.optional(),
    sessionGrants: z.array(toolRiskSchema).max(4).optional(),
    yolo: z.boolean().optional(),
  })
  .strict()
  .refine((request) => request.enforce !== true || request.policies !== undefined);

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

const FORWARDED_REQUEST_SCHEMAS = {
  contextTokenCount: countSchema,
  mainRootId: idSchema,
  mainRootPath: pathSchema,
  permissionPolicyRequest: permissionPolicyRequestSchema,
  projectId: idSchema,
  selectionFilePaths: z.array(pathSchema).max(MAX_LIST_ITEMS),
  selectionFilePathsFromOtherRoots: countSchema.max(MAX_LIST_ITEMS),
  selectionFolderId: idSchema,
  tokenBudget: z.number().int().positive().max(MAX_COUNT).nullable(),
  workspaceContext: workspaceContextSchema,
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
const ACCEPTED_IGNORED_WIRE_FIELDS = [
  'agentLoop',
  'enabledNativeToolIds',
  'mcpEnabled',
  'model',
  'modelSettings',
  'provider',
  'providerOptions',
] as const satisfies readonly (keyof RuntimeData)[];
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
  return { data: parsed as ForwardedRuntimeData, success: true };
}
