import {
  MCP_TASK_PRESENTATION_HISTORY_LIMIT,
  MCP_TASK_PRESENTATION_PROTOCOL_VERSION,
  type McpTaskActionRequest,
  type McpTaskActionResult,
  type McpTaskDiagnostic,
  type McpTaskHandle,
  type McpTaskPresentation,
  type McpTaskPresentationControllerPort,
  parseMcpTaskActionRequest,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import type { McpTaskRecord, McpTaskScope } from '@brainstrike/db';

export const MCP_TASK_CONTEXT_MAX_BYTES = 2048;

const TEXT_ENCODER = new TextEncoder();
const TRUNCATED_SUFFIX = '… [truncated]';

export interface McpTaskControlEnvironment {
  readonly capabilityAvailable: boolean;
  readonly protocolVersion: string | null;
  readonly scope: McpTaskScope | null;
}

export interface McpTaskPresentationControllerOptions {
  readonly execute: (request: McpTaskActionRequest) => Promise<McpTaskRecord>;
  readonly readEnvironment: () => McpTaskControlEnvironment;
}

export interface McpTaskContextProjection {
  readonly history: McpTaskPresentation['history'];
  readonly kind: 'mcp_task_status';
  readonly omittedHistoryEntries: number;
  readonly status: McpTaskPresentation['status'];
  readonly statusMessage: string | null;
  readonly updatedAt: string;
}

function diagnostic(code: McpTaskDiagnostic['code'], message: string): McpTaskActionResult {
  return { diagnostic: { code, message }, ok: false };
}

function equalScope(left: McpTaskHandle, right: McpTaskScope): boolean {
  return (
    left.authorityEpoch === right.authorityEpoch &&
    left.principalId === right.principalId &&
    left.resource === right.resource &&
    left.serverId === right.serverId
  );
}

function equalIdentity(left: McpTaskHandle, right: McpTaskRecord): boolean {
  return equalScope(left, right) && left.taskId === right.taskId;
}

function diagnoseControl(
  handle: McpTaskHandle,
  environment: McpTaskControlEnvironment
): McpTaskActionResult | null {
  if (environment.protocolVersion !== MCP_TASK_PRESENTATION_PROTOCOL_VERSION) {
    return diagnostic(
      'unsupported_version',
      `MCP Tasks controls require protocol ${MCP_TASK_PRESENTATION_PROTOCOL_VERSION}.`
    );
  }
  if (!environment.capabilityAvailable) {
    return diagnostic(
      'capability_removed',
      'This server no longer advertises the MCP Tasks capability.'
    );
  }
  const scope = environment.scope;
  if (scope === null || scope.principalId !== handle.principalId) {
    return diagnostic(
      'lost_principal',
      'The authorization principal that owns this MCP task is no longer available.'
    );
  }
  if (!equalScope(handle, scope)) {
    return diagnostic(
      'stale_handle',
      'This MCP task handle belongs to a replaced server connection.'
    );
  }
  return null;
}

function projectHistory(record: McpTaskRecord): {
  readonly history: McpTaskPresentation['history'];
  readonly omittedHistoryEntries: number;
} {
  const firstKept = Math.max(0, record.history.length - MCP_TASK_PRESENTATION_HISTORY_LIMIT);
  return {
    history: record.history.slice(firstKept).map((entry) => ({
      at: entry.at.toISOString(),
      status: entry.status,
    })),
    omittedHistoryEntries: firstKept,
  };
}

export function projectMcpTaskRecord(
  record: McpTaskRecord,
  recovery: 'live' | 'restart_required' = 'live'
): McpTaskPresentation {
  const terminal = record.terminalAt !== null;
  return {
    canCancel: !terminal,
    createdAt: record.createdAt.toISOString(),
    handle: {
      authorityEpoch: record.authorityEpoch,
      principalId: record.principalId,
      resource: record.resource,
      serverId: record.serverId,
      taskId: record.taskId,
    },
    ...projectHistory(record),
    recovery: terminal ? 'terminal' : recovery,
    status: record.status,
    statusMessage: record.statusMessage,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function serializedBytes(value: McpTaskContextProjection): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).length;
}

function fitStatusMessage(
  projection: Omit<McpTaskContextProjection, 'statusMessage'>,
  message: string | null
): string | null {
  if (message === null) {
    return null;
  }
  if (serializedBytes({ ...projection, statusMessage: message }) <= MCP_TASK_CONTEXT_MAX_BYTES) {
    return message;
  }
  const characters = [...message];
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = `${characters.slice(0, midpoint).join('')}${TRUNCATED_SUFFIX}`;
    if (
      serializedBytes({ ...projection, statusMessage: candidate }) <= MCP_TASK_CONTEXT_MAX_BYTES
    ) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  return `${characters.slice(0, lower).join('')}${TRUNCATED_SUFFIX}`;
}

export function projectMcpTaskForContext(task: McpTaskPresentation): McpTaskContextProjection {
  const projection = {
    history: task.history,
    kind: 'mcp_task_status' as const,
    omittedHistoryEntries: task.omittedHistoryEntries,
    status: task.status,
    updatedAt: task.updatedAt,
  };
  return {
    ...projection,
    statusMessage: fitStatusMessage(projection, task.statusMessage),
  };
}

export class McpTaskPresentationController implements McpTaskPresentationControllerPort {
  private readonly execute: McpTaskPresentationControllerOptions['execute'];
  private readonly readEnvironment: McpTaskPresentationControllerOptions['readEnvironment'];

  constructor(options: McpTaskPresentationControllerOptions) {
    this.execute = options.execute;
    this.readEnvironment = options.readEnvironment;
  }

  async act(input: McpTaskActionRequest): Promise<McpTaskActionResult> {
    const request = parseMcpTaskActionRequest(input);
    const controlFailure = diagnoseControl(request.handle, this.readEnvironment());
    if (controlFailure) {
      return controlFailure;
    }
    const record = await this.execute(request);
    const postExecutionFailure = diagnoseControl(request.handle, this.readEnvironment());
    if (postExecutionFailure) {
      return postExecutionFailure;
    }
    if (!equalIdentity(request.handle, record)) {
      return diagnostic('stale_handle', 'The MCP task authority returned a different task handle.');
    }
    if (request.action === 'cancel' && record.status !== 'cancelled') {
      return diagnostic(
        'action_failed',
        'The MCP task reached a terminal state other than cancelled.'
      );
    }
    return { ok: true, task: projectMcpTaskRecord(record) };
  }
}
