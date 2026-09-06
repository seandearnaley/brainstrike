import { z } from 'zod';

export const MCP_TASK_PRESENTATION_HISTORY_LIMIT = 8;
export const MCP_TASK_PRESENTATION_PROTOCOL_VERSION = '2026-07-28';

export const McpTaskStatusSchema = z.enum([
  'working',
  'input_required',
  'completed',
  'cancelled',
  'failed',
]);

export type McpTaskStatus = z.infer<typeof McpTaskStatusSchema>;

export const McpTaskHandleSchema = z.strictObject({
  authorityEpoch: z.uuid(),
  principalId: z.string().min(1).max(512),
  resource: z.string().min(1).max(2048),
  serverId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(1024),
});

export type McpTaskHandle = z.infer<typeof McpTaskHandleSchema>;

export const McpTaskHistoryEntrySchema = z.strictObject({
  at: z.string().datetime({ offset: true }),
  status: McpTaskStatusSchema,
});

export type McpTaskHistoryEntry = z.infer<typeof McpTaskHistoryEntrySchema>;

const McpTaskStatusMessageSchema = z
  .string()
  .max(4096)
  .refine((value) => new TextEncoder().encode(value).length <= 4096, {
    message: 'MCP task statusMessage must contain at most 4096 UTF-8 bytes.',
  });

export const McpTaskPresentationSchema = z.strictObject({
  canCancel: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  handle: McpTaskHandleSchema,
  history: z.array(McpTaskHistoryEntrySchema).max(MCP_TASK_PRESENTATION_HISTORY_LIMIT),
  omittedHistoryEntries: z.number().int().nonnegative().safe(),
  recovery: z.enum(['live', 'restart_required', 'terminal']),
  status: McpTaskStatusSchema,
  statusMessage: McpTaskStatusMessageSchema.nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

export type McpTaskPresentation = z.infer<typeof McpTaskPresentationSchema>;

export const McpTaskDiagnosticCodeSchema = z.enum([
  'stale_handle',
  'lost_principal',
  'unsupported_version',
  'capability_removed',
  'action_failed',
]);

export type McpTaskDiagnosticCode = z.infer<typeof McpTaskDiagnosticCodeSchema>;

export const McpTaskDiagnosticSchema = z.strictObject({
  code: McpTaskDiagnosticCodeSchema,
  message: z.string().min(1).max(512),
});

export type McpTaskDiagnostic = z.infer<typeof McpTaskDiagnosticSchema>;

export const McpTaskActionRequestSchema = z.strictObject({
  action: z.enum(['recover', 'cancel']),
  handle: McpTaskHandleSchema,
});

export type McpTaskActionRequest = z.infer<typeof McpTaskActionRequestSchema>;

export type McpTaskActionResult =
  | { readonly ok: true; readonly task: McpTaskPresentation }
  | { readonly diagnostic: McpTaskDiagnostic; readonly ok: false };

export interface McpTaskPresentationControllerPort {
  act(request: McpTaskActionRequest): Promise<McpTaskActionResult>;
}

export function parseMcpTaskPresentation(value: unknown): McpTaskPresentation {
  return McpTaskPresentationSchema.parse(value);
}

export function parseMcpTaskActionRequest(value: unknown): McpTaskActionRequest {
  return McpTaskActionRequestSchema.parse(value);
}
