import {
  type AgentMessage,
  type AssistantToolApprovalAction,
  type StreamChunk,
  streamMastraToolApprovalAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import {
  createPgliteMastraMemory,
  type PgliteDatabase,
  type PgliteMastraMemoryResult,
} from '@brainstrike/agent/pglite-mastra-memory';
import { createLogger } from '@brainstrike/utils/logger';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { resolveWebAssistantRuntime } from './web-assistant-runtime';

const logger = createLogger('WebMastraStorage');

let storagePromise: Promise<PgliteMastraMemoryResult> | undefined;
let activeDatabase: PGlite | undefined;

/**
 * Lazily construct ONE in-process PGlite-backed Mastra store for the web Vite
 * Node server (dev/preview only — a static prod deploy has no Node server).
 *
 * Why a module-level singleton: per-call tool approval suspends a run, persists a
 * workflow snapshot, and resumes it on a SEPARATE later HTTP request. Both
 * requests hit the same long-lived Vite server process, so the snapshot must live
 * in one shared store across requests — module scope is the correct lifetime.
 * In-memory (no path) is intentional: a stale suspended run after a server
 * restart simply cannot be resumed (surfaced as an error, not silently).
 *
 * A failed init never caches a permanently-rejected promise and never leaks the
 * half-built engine — it resets the singleton and closes the database so the next
 * request retries cleanly.
 */
export function getWebMastraStorage(): Promise<PgliteMastraMemoryResult> {
  if (!storagePromise) {
    storagePromise = initWebMastraStorage().catch(async (error: unknown) => {
      storagePromise = undefined;
      await closeActiveDatabase();
      throw error;
    });
  }
  return storagePromise;
}

async function initWebMastraStorage(): Promise<PgliteMastraMemoryResult> {
  // PGlite Extension Invariant (docs/agents/database.md): load the same engine-extension set as
  // every other construction site so any path that later touches the Mastra
  // vector store (semantic recall / observational vector retrieval once an
  // embedder is threaded) can run `CREATE EXTENSION vector` without the cryptic
  // "could not open extension control file" footgun, and so this site does not
  // drift from future extension additions. `live` is renderer-only (client
  // reactive queries) and is not loaded server-side — matching pglite-worker-entry.
  // biome-ignore lint/style/useNamingConvention: `pg_trgm` is PGlite's external extension key, not ours to rename.
  const database = new PGlite({ extensions: { pg_trgm: pgTrgm, vector } });
  await database.waitReady;
  activeDatabase = database;
  logger.info('Web Mastra storage initialized (in-memory PGlite, dev/preview)');
  return createPgliteMastraMemory({ database: database as unknown as PgliteDatabase });
}

async function closeActiveDatabase(): Promise<void> {
  const database = activeDatabase;
  activeDatabase = undefined;
  if (!database) {
    return;
  }
  try {
    await database.close();
  } catch (error) {
    // Best-effort: a failed close must not wedge a reset/retry.
    logger.warn('Failed to close web Mastra PGlite engine', { error });
  }
}

/**
 * Build the assistant stream for a web request, backed by the shared workflow
 * storage. With storage present, "ask" tools SUSPEND for per-call approval
 * (rather than being fail-safe omitted) and the approval-resume path works.
 *
 * Web is intentionally session-only for CONVERSATION: we pass the workflow
 * `storage` (the suspend/resume snapshot store, and the `Boolean(storage)` gate
 * that lets ask tools suspend) but NOT a Mastra `memory` instance. Passing memory
 * would turn observational memory ON by default (an extra model generation per
 * turn the web client never asked for) and pin a single first-construction memory
 * config, ignoring per-request settings — the opposite of the desktop's
 * per-request memory build. Conversation history stays client-supplied per turn.
 */
export async function buildWebAssistantStream(params: {
  readonly agentMessages: AgentMessage[];
  readonly data: unknown;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
  readonly toolApprovalAction?: AssistantToolApprovalAction;
}): Promise<AsyncIterable<StreamChunk>> {
  const runtime = resolveWebAssistantRuntime(params.data, params.apiKey, params.signal);
  const { storage } = await getWebMastraStorage();
  if (params.toolApprovalAction) {
    return streamMastraToolApprovalAction(params.toolApprovalAction, {
      requireToolApproval: true,
      runtime,
      storage,
    });
  }
  return toAiSdkStyleStream(params.agentMessages, runtime, { storage });
}

/** Test seam: reset + close the singleton so each integration test gets a fresh store. */
export async function resetWebMastraStorageForTests(): Promise<void> {
  storagePromise = undefined;
  await closeActiveDatabase();
}
