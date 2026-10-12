import {
  AGENT_READONLY_ROLE_CREATE_SQL,
  AGENT_READONLY_ROLE_DROP_SQL,
} from './074-agent-readonly-role.js';
import type { Migration } from './migration-runner.js';

/**
 * Migration 151: drop the `brainstrike.querySelf` read-only role (BST-1995).
 *
 * querySelf and its lenses are removed, and nothing else assumes the role.
 * `up` is migration 074's own rollback: it revokes the role's schema usage,
 * table grants and future-table default, then drops it. Like that rollback, it
 * leaves the PUBLIC revokes on `pg_sleep*` and `set_config` in place; no
 * application code calls them. `down` re-applies 074.
 */
export const migration151DropAgentReadonlyRole: Migration = {
  down: AGENT_READONLY_ROLE_CREATE_SQL,
  ledgerKey: 'custom-151-drop-agent-readonly-role',
  name: 'drop_agent_readonly_role',
  up: AGENT_READONLY_ROLE_DROP_SQL,
  version: 151,
};
