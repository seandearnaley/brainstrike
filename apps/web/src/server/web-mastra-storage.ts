import {
  type AgentMessage,
  type AssistantToolApprovalAction,
  type RuntimeData,
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

const logger = createLogger('WebMastraStorage');

let storagePromise: Promise<PgliteMastraMemoryResult> | undefined;

/**
 * Lazily construct ONE in-process PGlite-backed Mastra store for the web Vite
 * Node server (dev/preview only — a static prod deploy has no Node server).
 *
 * Why a module-level singleton: per-call tool approval suspends a run, persists
 * a workflow snapshot, and resumes it on a SEPARATE later HTTP request. Both
 * requests hit the same long-lived Vite server process, so the snapshot must
 * live in one shared store across requests — module scope is the correct
 * lifetime. In-memory (no path) is intentional: the data need not survive a
 * server restart (a stale suspended run simply cannot be resumed, surfaced as an
 * error rather than silently). This mirrors the desktop assistant server, which
 * uses a (persistent) PGlite-backed Mastra store for the same suspend/resume.
 *
 * No PGlite extensions are loaded (PGlite Extension Invariant, AGENTS.md): this
 * site runs NO `CREATE EXTENSION`. `createPgliteMastraMemory`'s `store.init()` +
 * `workflows.init()` are extension-free (proven by the agent package's
 * `mastra-tool-approval-suspend.spec.ts`, which drives a full suspend/resume on a
 * bare `new PGlite()`). The only path that would `CREATE EXTENSION vector` is the
 * lazily-init'd vector store, and that path is pre-guarded: createPgliteMastraMemory
 * THROWS a clear error if semantic recall / observational vector retrieval is
 * enabled without an embedder (web supplies none), so it never reaches a
 * `CREATE EXTENSION` on a bare engine. The cryptic footgun therefore cannot occur.
 */
export function getWebMastraStorage(): Promise<PgliteMastraMemoryResult> {
  if (!storagePromise) {
    storagePromise = initWebMastraStorage().catch((error: unknown) => {
      // Never cache a permanently-rejected promise: reset so a transient init
      // failure can be retried on the next request (no silent dead state).
      storagePromise = undefined;
      throw error;
    });
  }
  return storagePromise;
}

async function initWebMastraStorage(): Promise<PgliteMastraMemoryResult> {
  const database = new PGlite();
  await database.waitReady;
  logger.info('Web Mastra storage initialized (in-memory PGlite, dev/preview)');
  return createPgliteMastraMemory({ database: database as unknown as PgliteDatabase });
}

/**
 * Build the assistant stream for a web request, backed by the shared workflow
 * storage. With storage present, "ask" tools SUSPEND for per-call approval
 * (rather than being fail-safe omitted) and the approval-resume path works —
 * desktop parity. Mirrors the desktop assistant server: pass `{ memory, storage }`
 * on BOTH the normal turn and the resume.
 *
 * @param runtime the request runtime (data + apiKey, plus an optional abort
 *   `signal` the caller threads through) — passed verbatim to the agent loop.
 */
export async function buildWebAssistantStream(params: {
  readonly agentMessages: AgentMessage[];
  readonly runtime: RuntimeData;
  readonly toolApprovalAction?: AssistantToolApprovalAction;
}): Promise<AsyncIterable<StreamChunk>> {
  const { memory, storage } = await getWebMastraStorage();
  if (params.toolApprovalAction) {
    return streamMastraToolApprovalAction(params.toolApprovalAction, {
      memory,
      storage,
      requireToolApproval: true,
      runtime: params.runtime,
    });
  }
  return toAiSdkStyleStream(params.agentMessages, params.runtime, { memory, storage });
}

/** Test seam: reset the singleton so each integration test gets a fresh store. */
export function resetWebMastraStorageForTests(): void {
  storagePromise = undefined;
}
