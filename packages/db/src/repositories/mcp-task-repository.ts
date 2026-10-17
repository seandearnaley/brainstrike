import { McpTaskStore } from '@brainstrike/assistant-contract/mcp-task-store';
import { pgliteMcpTaskStorage } from './mcp-task-pglite-storage.js';

export interface McpTaskDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The PGlite Tasks tables, until the host StateStore owns every Tasks row. */
export class McpTaskRepository extends McpTaskStore {
  constructor(db: McpTaskDatabase, now?: () => Date) {
    super(pgliteMcpTaskStorage(db), now);
  }
}
