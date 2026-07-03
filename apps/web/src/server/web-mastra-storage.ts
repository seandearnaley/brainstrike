import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentMessage,
  type AssistantToolApprovalAction,
  type RuntimeData,
  type StreamChunk,
  streamMastraToolApprovalAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import {
  createTursoMastraMemory,
  type TursoMastraMemoryResult,
  type TursoMastraQueryValue,
  type TursoMastraQueryValues,
  type TursoMastraSqlClient,
} from '@brainstrike/agent/turso-mastra-memory';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveWebAssistantRuntime } from './web-assistant-runtime';

const logger = createLogger('WebMastraStorage');

let storagePromise: Promise<TursoMastraMemoryResult> | undefined;
let activeOwnerClient: TursoOwnerClient | undefined;
let activeProfileDir: string | undefined;

/**
 * Lazily construct ONE in-process Turso-backed Mastra store for the web Vite
 * Node server (dev/preview only — a static prod deploy has no Node server).
 *
 * Why a module-level singleton: per-call tool approval suspends a run, persists a
 * workflow snapshot, and resumes it on a SEPARATE later HTTP request. Both
 * requests hit the same long-lived Vite server process, so the snapshot must live
 * in one shared store across requests — module scope is the correct lifetime.
 * A fresh temp profile per server process preserves the old process-lifetime
 * web behavior: a stale suspended run after a server restart simply cannot be
 * resumed (surfaced as an error, not silently).
 *
 * A failed init never caches a permanently-rejected promise and never leaks the
 * half-built engine — it resets the singleton and closes the owner so the next
 * request retries cleanly.
 */
export function getWebMastraStorage(): Promise<TursoMastraMemoryResult> {
  if (!storagePromise) {
    storagePromise = initWebMastraStorage().catch(async (error: unknown) => {
      storagePromise = undefined;
      throw error;
    });
  }
  return storagePromise;
}

export async function disposeWebMastraStorage(): Promise<void> {
  const pendingStorage = storagePromise;
  storagePromise = undefined;
  let pendingError: unknown;
  if (pendingStorage) {
    try {
      await pendingStorage;
    } catch (error) {
      pendingError = error;
    }
  }
  try {
    await closeActiveProfile();
  } catch (cleanupError) {
    if (pendingError) {
      throw new AggregateError(
        [pendingError, cleanupError],
        'Failed to dispose web Mastra Turso profile'
      );
    }
    throw cleanupError;
  }
  if (pendingError) {
    throw pendingError;
  }
}

async function initWebMastraStorage(): Promise<TursoMastraMemoryResult> {
  const profileDir = await mkdtemp(join(tmpdir(), 'brainstrike-web-mastra-turso-'));
  let ownerClient: TursoOwnerClient | undefined;
  try {
    ownerClient = await createTursoOwnerClient({ dbPath: join(profileDir, 'profile.db') });
    const result = await createTursoMastraMemory({
      database: createOwnerMastraSqlClient(ownerClient),
      id: 'brainstrike-web-turso-memory',
    });
    activeOwnerClient = ownerClient;
    activeProfileDir = profileDir;
    logger.info('Web Mastra storage initialized (temp Turso profile, dev/preview)');
    return result;
  } catch (error) {
    const cleanupErrors = await cleanupProfile(ownerClient, profileDir);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Failed to initialize web Mastra storage and clean up temp profile'
      );
    }
    throw error;
  }
}

function createOwnerMastraSqlClient(ownerClient: TursoOwnerClient): TursoMastraSqlClient {
  return createMastraSqlClient(ownerClient, async (operation) =>
    ownerClient.transaction(async (tx) => operation(createMastraSqlClient(tx)))
  );
}

function createMastraSqlClient(
  client: Pick<TursoOwnerClient, 'exec' | 'query'>,
  transaction?: TursoMastraSqlClient['transaction']
): TursoMastraSqlClient {
  return {
    exec: async (query, values) => client.exec(query, normalizeValues(values)),
    query: async <TRecord extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      values?: TursoMastraQueryValues
    ) => {
      const result = await client.query<TRecord>(query, normalizeValues(values));
      return { rows: [...result.rows] };
    },
    ...(transaction ? { transaction } : {}),
  };
}

function normalizeValues(
  values: TursoMastraQueryValues | undefined
): readonly unknown[] | undefined {
  return values?.map(normalizeValue);
}

function normalizeValue(value: TursoMastraQueryValue): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function closeActiveProfile(): Promise<void> {
  const ownerClient = activeOwnerClient;
  const profileDir = activeProfileDir;
  activeOwnerClient = undefined;
  activeProfileDir = undefined;
  const cleanupErrors = await cleanupProfile(ownerClient, profileDir);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Failed to dispose web Mastra Turso profile');
  }
}

async function cleanupProfile(
  ownerClient: TursoOwnerClient | undefined,
  profileDir: string | undefined
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await closeOwnerClient(ownerClient);
  } catch (error) {
    errors.push(error);
  }
  try {
    await removeProfileDir(profileDir);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function closeOwnerClient(ownerClient: TursoOwnerClient | undefined): Promise<void> {
  if (!ownerClient) {
    return;
  }
  try {
    await ownerClient.close();
  } catch (error) {
    logger.warn('Failed to close web Mastra Turso owner client', { error });
    throw error;
  }
}

async function removeProfileDir(profileDir: string | undefined): Promise<void> {
  if (!profileDir) {
    return;
  }
  try {
    await rm(profileDir, { force: true, recursive: true });
  } catch (error) {
    logger.warn('Failed to remove web Mastra Turso temp profile', { error, profileDir });
    throw error;
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
  readonly data: RuntimeData | undefined;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
  readonly toolApprovalAction?: AssistantToolApprovalAction;
}): Promise<AsyncIterable<StreamChunk>> {
  const runtime = resolveWebAssistantRuntime(params.data, params.apiKey, params.signal);
  const { storage } = await getWebMastraStorage();
  if (params.toolApprovalAction) {
    return streamMastraToolApprovalAction(params.toolApprovalAction, {
      storage,
      requireToolApproval: true,
      runtime,
    });
  }
  return toAiSdkStyleStream(params.agentMessages, runtime, { storage });
}

/** Test seam: reset + close the singleton so each integration test gets a fresh store. */
export async function resetWebMastraStorageForTests(): Promise<void> {
  await disposeWebMastraStorage();
}
