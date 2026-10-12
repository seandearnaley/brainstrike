import type { Migration } from './migration-runner';

/**
 * Migration 074: the non-superuser role used by the agent SQL sandbox.
 *
 * This role is ONE OF FOUR independent, engine-enforced layers behind
 * `brainstrike.querySelf`. It is the layer that blocks privilege escalation the
 * read-only transaction cannot: `pg_read_file` / `pg_ls_dir` (arbitrary
 * filesystem reads that would bypass workspace-root containment and the
 * permission engine entirely), `COPY … TO PROGRAM`, and `pg_authid`. Those
 * functions are superuser-gated by default in PostgreSQL, so running as a
 * plain role is what denies them — a read-only transaction alone does NOT.
 *
 * Full contract, including the measured evidence for every layer:
 * `docs/agents/agent-self-query.md`.
 *
 * NOLOGIN is deliberate: this is an authorization identity assumed via
 * `SET LOCAL ROLE` inside a transaction, never a connection identity. PGlite
 * has a single implicit superuser connection; nothing ever logs in as this
 * role.
 *
 * `CREATE ROLE` has no `IF NOT EXISTS`, and the dual-runner design (numbered
 * runner for tests + drizzle `customMigrations` for the real app) can execute
 * this SQL twice against one store, so the `pg_roles` guard is required rather
 * than defensive. The GRANTs are naturally idempotent.
 *
 * `ALTER DEFAULT PRIVILEGES` covers tables created by LATER migrations, which
 * all run as `postgres`. `migration-074-agent-readonly-role.test.ts` proves
 * both the catch-up grant and the future-table grant rather than assuming
 * them — that test is the tripwire for a future migration that lands a table
 * the agent cannot read.
 *
 * THE REVOKES ARE LOAD-BEARING, not hardening theatre. Both close verified
 * escapes that every other sandbox layer admits:
 *
 * - `pg_sleep` / `pg_sleep_for` / `pg_sleep_until` plan at cost 0.01, so the
 *   EXPLAIN cost gate admits `SELECT pg_sleep(86400)`. PGlite does not enforce
 *   `statement_timeout` and is a single connection, so that one statement
 *   freezes the whole application for a day. Measured: it passed the gate and
 *   held the connection for the full requested duration.
 * - `set_config(text, text, boolean)` with `is_local => false` performs a
 *   SESSION-level SET from inside the submitted statement. It is not a write,
 *   so the read-only transaction allows it, and PostgreSQL applies the session
 *   value once the transaction's `SET LOCAL ROLE` unwinds — leaving the shared
 *   connection stuck as the restricted role AFTER the sandbox returns.
 *   Measured: the application's own writes then failed with
 *   `permission denied`, permanently, from a tool marked `read`.
 *
 * Revoking from PUBLIC (not just from the role) is correct: no application code
 * calls these, and `postgres` retains access as superuser. Pinned by tests.
 */
/** Creates the role and its grants; migration 151's rollback re-applies it. */
export const AGENT_READONLY_ROLE_CREATE_SQL = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly') THEN
        CREATE ROLE brainstrike_agent_readonly NOLOGIN;
      END IF;
    END $$;

    GRANT USAGE ON SCHEMA public TO brainstrike_agent_readonly;

    GRANT SELECT ON ALL TABLES IN SCHEMA public TO brainstrike_agent_readonly;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT ON TABLES TO brainstrike_agent_readonly;

    REVOKE EXECUTE ON FUNCTION pg_sleep(double precision) FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION pg_sleep_for(interval) FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION pg_sleep_until(timestamp with time zone) FROM PUBLIC;

    REVOKE EXECUTE ON FUNCTION set_config(text, text, boolean) FROM PUBLIC;
  `;

/** Drops the role and its grants; migration 151 runs it to remove the role. */
export const AGENT_READONLY_ROLE_DROP_SQL = `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly') THEN
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE SELECT ON TABLES FROM brainstrike_agent_readonly;
        REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM brainstrike_agent_readonly;
        REVOKE USAGE ON SCHEMA public FROM brainstrike_agent_readonly;
        DROP ROLE brainstrike_agent_readonly;
      END IF;
    END $$;
  `;

export const migration074AgentReadonlyRole: Migration = {
  down: AGENT_READONLY_ROLE_DROP_SQL,
  ledgerKey: 'custom-074-agent-readonly-role',
  name: 'agent_readonly_role',
  up: AGENT_READONLY_ROLE_CREATE_SQL,
  version: 74,
};
