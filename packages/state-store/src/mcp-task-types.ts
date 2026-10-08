/** Data-only MCP Tasks port executed by the existing StateStore writer (BST-1930 ruling B). */
export type McpTaskStatusWire = 'cancelled' | 'completed' | 'failed' | 'input_required' | 'working';

export interface McpTaskScopeWire {
  readonly authorityEpoch: string;
  readonly principalId: string;
  readonly resource: string;
  readonly serverId: string;
}

export interface McpTaskLeaseWire extends McpTaskScopeWire {
  readonly connectionGeneration: number;
  readonly runtimeId: string;
}

export interface McpTaskIdentityWire extends McpTaskScopeWire {
  readonly taskId: string;
}

export interface McpTaskInsertWire {
  readonly at: string;
  readonly blockedDiagnostic: string | null;
  readonly history: string;
  readonly inputMetadata: string | null;
  readonly resultMetadata: string | null;
  readonly status: McpTaskStatusWire;
  readonly statusMessage: string | null;
  readonly taskId: string;
  readonly terminalAt: string | null;
  readonly threadId: string | null;
}

export interface McpTaskPatchWire {
  readonly at: string;
  readonly blockedDiagnostic: string | null;
  readonly hasBlocked: boolean;
  readonly hasInput: boolean;
  readonly hasMessage: boolean;
  readonly hasResult: boolean;
  readonly historyEntry: string;
  readonly inputMetadata: string | null;
  readonly resultMetadata: string | null;
  readonly status: McpTaskStatusWire;
  readonly statusMessage: string | null;
  readonly terminal: boolean;
}

export type McpTaskDomainRequest =
  | {
      readonly at: string;
      /** Caller-minted UUIDv7, used only when a new authority is created. */
      readonly authorityEpoch: string;
      readonly input: Omit<McpTaskLeaseWire, 'authorityEpoch'>;
      readonly operation: 'open-authority';
    }
  | {
      readonly at: string;
      readonly lease: McpTaskLeaseWire;
      readonly operation: 'retire-authority';
    }
  | {
      readonly lease: McpTaskLeaseWire;
      readonly operation: 'insert';
      readonly row: McpTaskInsertWire;
    }
  | { readonly identity: McpTaskIdentityWire; readonly operation: 'get' }
  | { readonly lease: McpTaskLeaseWire; readonly limit: number; readonly operation: 'list-active' }
  | {
      readonly identity: McpTaskIdentityWire;
      readonly lease: McpTaskLeaseWire;
      readonly operation: 'update';
      readonly patch: McpTaskPatchWire;
    };

/** A row in the PostgreSQL column shape: JSON columns parsed, timestamps ISO text. */
export type McpTaskDomainRow = Readonly<Record<string, unknown>>;

export interface McpTaskDomainReply {
  readonly rows: readonly McpTaskDomainRow[];
}
