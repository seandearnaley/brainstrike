import type { Migration } from './migration-runner';

/** Restart-safe authority epochs and bounded blocked-state diagnostics (BST-1581). */
export const migration115McpTaskAuthority: Migration = {
  down: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM brainstrike_mcp_tasks
        WHERE blocked_diagnostic IS NOT NULL
          AND status NOT IN ('completed', 'failed', 'cancelled')
      ) THEN
        RAISE EXCEPTION
          'Cannot roll back MCP task authority: blocked nonterminal rows are not representable by migration 114';
      END IF;
    END
    $$;

    ALTER TABLE brainstrike_mcp_tasks ADD COLUMN generation bigint;
    UPDATE brainstrike_mcp_tasks AS task
    SET generation = authority.connection_generation
    FROM brainstrike_mcp_task_authorities AS authority
    WHERE task.authority_epoch = authority.authority_epoch;
    ALTER TABLE brainstrike_mcp_tasks ALTER COLUMN generation SET NOT NULL;

    DROP INDEX IF EXISTS brainstrike_mcp_tasks_resume_idx;
    ALTER TABLE brainstrike_mcp_tasks
      DROP CONSTRAINT brainstrike_mcp_tasks_authority_fk,
      DROP CONSTRAINT brainstrike_mcp_tasks_pkey,
      DROP CONSTRAINT brainstrike_mcp_tasks_terminal_state_check,
      DROP CONSTRAINT brainstrike_mcp_tasks_blocked_diagnostic_object_check,
      DROP CONSTRAINT brainstrike_mcp_tasks_blocked_diagnostic_size_check,
      DROP COLUMN authority_epoch,
      DROP COLUMN blocked_diagnostic,
      ADD PRIMARY KEY (server_id, resource, principal_id, generation, task_id),
      ADD CHECK ((status IN ('completed', 'failed', 'cancelled')) = (terminal_at IS NOT NULL));
    CREATE INDEX brainstrike_mcp_tasks_resume_idx
      ON brainstrike_mcp_tasks (server_id, resource, principal_id, generation, updated_at)
      WHERE terminal_at IS NULL;
    DROP TABLE brainstrike_mcp_task_authorities;
  `,
  ledgerKey: 'custom-115-mcp-task-authority',
  name: 'mcp_task_authority',
  up: `
    CREATE TABLE brainstrike_mcp_task_authorities (
      authority_epoch uuid PRIMARY KEY DEFAULT uuidv7(),
      server_id text NOT NULL CHECK (octet_length(server_id) BETWEEN 1 AND 512),
      resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
      principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 512),
      runtime_id text NOT NULL CHECK (octet_length(runtime_id) BETWEEN 1 AND 512),
      connection_generation bigint NOT NULL CHECK (connection_generation >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      retired_at timestamptz,
      UNIQUE (authority_epoch, server_id, resource, principal_id),
      CHECK (created_at <= updated_at),
      CHECK (retired_at IS NULL OR retired_at = updated_at)
    );
    CREATE UNIQUE INDEX brainstrike_mcp_task_authorities_live_scope_idx
      ON brainstrike_mcp_task_authorities (server_id, resource, principal_id)
      WHERE retired_at IS NULL;

    WITH generations AS (
      SELECT server_id,
             resource,
             principal_id,
             generation,
             MIN(created_at) AS created_at,
             MAX(updated_at) AS updated_at,
             MAX(generation) OVER (
               PARTITION BY server_id, resource, principal_id
             ) AS live_generation
      FROM brainstrike_mcp_tasks
      GROUP BY server_id, resource, principal_id, generation
    )
    INSERT INTO brainstrike_mcp_task_authorities (
      server_id,
      resource,
      principal_id,
      runtime_id,
      connection_generation,
      created_at,
      updated_at,
      retired_at
    )
    SELECT server_id,
           resource,
           principal_id,
           'migration-115-recovered',
           generation,
           created_at,
           updated_at,
           CASE WHEN generation = live_generation THEN NULL ELSE updated_at END
    FROM generations;

    ALTER TABLE brainstrike_mcp_tasks
      ADD COLUMN authority_epoch uuid,
      ADD COLUMN blocked_diagnostic jsonb;
    UPDATE brainstrike_mcp_tasks AS task
    SET authority_epoch = authority.authority_epoch
    FROM brainstrike_mcp_task_authorities AS authority
    WHERE task.server_id = authority.server_id
      AND task.resource = authority.resource
      AND task.principal_id = authority.principal_id
      AND task.generation = authority.connection_generation;
    ALTER TABLE brainstrike_mcp_tasks ALTER COLUMN authority_epoch SET NOT NULL;

    DROP INDEX brainstrike_mcp_tasks_resume_idx;
    ALTER TABLE brainstrike_mcp_tasks
      DROP CONSTRAINT brainstrike_mcp_tasks_pkey,
      ADD PRIMARY KEY (authority_epoch, task_id),
      ADD CONSTRAINT brainstrike_mcp_tasks_authority_fk
        FOREIGN KEY (authority_epoch, server_id, resource, principal_id)
        REFERENCES brainstrike_mcp_task_authorities (
          authority_epoch, server_id, resource, principal_id
        )
        ON DELETE CASCADE;

    DO $$
    DECLARE
      terminal_constraint text;
    BEGIN
      SELECT constraint_record.conname
      INTO terminal_constraint
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      WHERE relation.relname = 'brainstrike_mcp_tasks'
        AND constraint_record.contype = 'c'
        AND pg_get_constraintdef(constraint_record.oid) LIKE '%terminal_at%'
        AND pg_get_constraintdef(constraint_record.oid) LIKE '%status%'
        AND pg_get_constraintdef(constraint_record.oid) NOT LIKE '%created_at%';

      IF terminal_constraint IS NULL THEN
        RAISE EXCEPTION 'Migration 114 MCP task terminal-state constraint is missing';
      END IF;
      EXECUTE format(
        'ALTER TABLE brainstrike_mcp_tasks DROP CONSTRAINT %I',
        terminal_constraint
      );
    END
    $$;

    ALTER TABLE brainstrike_mcp_tasks
      DROP COLUMN generation,
      ADD CONSTRAINT brainstrike_mcp_tasks_terminal_state_check CHECK (
        (status IN ('completed', 'failed', 'cancelled') OR blocked_diagnostic IS NOT NULL)
          = (terminal_at IS NOT NULL)
      ),
      ADD CONSTRAINT brainstrike_mcp_tasks_blocked_diagnostic_object_check CHECK (
        blocked_diagnostic IS NULL OR jsonb_typeof(blocked_diagnostic) = 'object'
      ),
      ADD CONSTRAINT brainstrike_mcp_tasks_blocked_diagnostic_size_check CHECK (
        octet_length(COALESCE(blocked_diagnostic::text, '')) <= 4096
      );
    CREATE INDEX brainstrike_mcp_tasks_resume_idx
      ON brainstrike_mcp_tasks (authority_epoch, updated_at)
      WHERE terminal_at IS NULL;
  `,
  version: 115,
};
