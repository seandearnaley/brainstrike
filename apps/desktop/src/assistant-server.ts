import http from 'node:http';
import {
  type AwsCredentialIdentityProvider,
  assistantDataStreamSessions,
  createAwsCredentialChain,
  type RuntimeData,
  resolveAwsCredentialChain,
} from '@brainstrike/agent';
import { ASSISTANT_AUTH_HEADER_NAME } from '@brainstrike/assistant-contract';
import {
  respondAssistantRejection,
  respondJson,
  respondNotFound,
} from '@brainstrike/assistant-service/http';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import { prepareAssistantPostRequest } from '@brainstrike/assistant-service/request';
import { runAssistantTurn } from '@brainstrike/assistant-service/run-turn';
import {
  registerSteerableRun,
  unregisterSteerableRun,
} from '@brainstrike/assistant-service/steering';
import {
  type AgentStreamCapabilities,
  initializeAgentStream,
} from '@brainstrike/assistant-service/stream-init';
import { ToolOutputArtifactRepository } from '@brainstrike/db';
import { buildDesktopAssistantTools } from './assistant-server/assistant-tools';
import {
  type AssistantServerAuth,
  isAuthorizedAssistantToken,
  mintAssistantServerAuthToken,
} from './assistant-server/auth';
import { createCompactionRangeLookup } from './assistant-server/compaction-range-repository';
import { handleCancelRequest, handleSteerRequest } from './assistant-server/control-endpoints';
import {
  createContextOverflowRecovery,
  runPreRequestCompaction,
} from './assistant-server/conversation-compaction';
import {
  applyAssistantCorsHeaders,
  hasDisallowedAssistantOrigin,
  isAssistantCorsPreflight,
  respondForbiddenOrigin,
} from './assistant-server/cors';
import type { EditCheckpointDatabase } from './assistant-server/edit-checkpoint-journal';
import type { HookRunVerdict } from './assistant-server/hooks/run-verdict';
import {
  finalizeHookedStream,
  hookRunEventToAssistant,
  makeHookBlockedStream,
  prepareRequestHooks,
  runUserPromptSubmitGate,
} from './assistant-server/hooks/server-integration';
import {
  assistantRequestBodyLimitBytes,
  readRequestBody,
  streamResponse,
} from './assistant-server/http';
import { desktopAssistantServerLogger } from './assistant-server/logger';
import {
  DesktopMemoryCredentialMissingError,
  getDesktopMastraMemory,
} from './assistant-server/mastra-memory';
import { createNodeFsScanDeps } from './assistant-server/node-fs-scan-deps';
import {
  resolveProviderApiKey,
  resolveProviderCredential,
} from './assistant-server/provider-credentials';
import { injectReferencedFilesContext } from './assistant-server/referenced-files-context';
import { registerRequestAbort } from './assistant-server/request-abort';
import { resolveRequestPersonas } from './assistant-server/request-personas';
import { prepareRequestSkills } from './assistant-server/request-skills';
import { readLastEventId, resolveAssistantRoute } from './assistant-server/routing';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
  persistDesktopTokenEstimateCalibration,
  persistDesktopToolCallTelemetry,
  recordDesktopAssistantHookRunOutcome,
  recordDesktopAssistantThreadRunStatus,
} from './assistant-server/run-persistence';
import { handleRunStatusRequest } from './assistant-server/run-status-endpoint';
import { recordDesktopContinuationRunTreatment } from './assistant-server/run-treatment-persistence';
import { respondToSecretReadError } from './assistant-server/secret-error-responses';
import { injectSelfImprovementSignalContext } from './assistant-server/self-improvement-signal-context';
import type { AssistantServerOptions } from './assistant-server/server-options';
import {
  createShellCorrelation,
  type ShellCorrelationCapability,
} from './assistant-server/shell-worktree-correlation';
import { injectActivatedSkillsContext } from './assistant-server/skills-activation-context';
import { createSecureSkillsFs } from './assistant-server/skills-fs-deps';
import {
  createTurnBoundaryController,
  type LegPauseState,
  observeTurnPauseChunks,
  resolveTurnAnchorMessageId,
} from './assistant-server/snapshot-turn-boundaries';
import {
  handleAssistantStatus,
  handleOpenRouterModelMetadata,
  handleSuspendedRunsRequest,
  handleVerifyProviderRequest,
} from './assistant-server/status-endpoints';
import {
  handleAssistantResumeRequest,
  resumeStreamIfAvailable,
} from './assistant-server/stream-resume';
import { readThreadTaskList } from './assistant-server/task-list-repository';
import { createToolProjectionRewriteLookup } from './assistant-server/tool-projection-rewrite-repository';
import { scanUserPersonas } from './assistant-server/user-personas-loader';
import { WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS } from './assistant-server/web-extract-model-projection';
import { injectWorkspaceInstructionsContext } from './assistant-server/workspace-instructions-context';
import {
  BoundWorkspaceRootUnavailableError,
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
} from './assistant-server/workspace-roots';
import { readWorkspaceTextFile } from './assistant-server/workspace-text-file-reader';
import type { WorktreeToolCapability } from './assistant-server/worktree-tools';
import { type DesktopDatabase, getDatabase } from './db-main';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { getMcpDesktopAppHost } from './mcp/apps-authority';
import { getDesktopMcpHostRuntime } from './mcp/host-runtime';
import { getSubscriptionFetchFactory } from './provider-auth/provider-auth-runtime';
import { resolveDesktopPythonExecutable } from './python-runtime';

const logger = desktopAssistantServerLogger;
const compactionOverlayLookup = createCompactionRangeLookup(getDatabase);
const toolProjectionRewriteLookup = createToolProjectionRewriteLookup(getDatabase);

/**
 * Desktop's instantiation of the service's opaque capability kinds
 * (BST-972 B4b): the host-internal types the stream initializer routes
 * between capability calls without inspecting. The ReturnType/Parameters
 * derivations are PLUMBING, not a safety net — they are defined as whatever
 * the implementation currently is. The real drift check is the contravariant
 * assignability of each implementation at the capabilities literal below
 * (a new required param on an adapter errors there); what nothing checks is
 * host-side RETURN widening the service ought to thread — the service sees
 * the restated signatures, not the real returns (review note on #2129).
 */
interface DesktopAgentStreamKinds {
  database: DesktopDatabase;
  embeddingHost: Pick<EmbeddingHostManager, 'queryEmbedding'>;
  hookEvent: Parameters<typeof hookRunEventToAssistant>[0];
  hookManager: ReturnType<typeof prepareRequestHooks>['manager'];
  hookVerdict: HookRunVerdict;
  personaScan: ReturnType<typeof scanUserPersonas>;
  scanFilesystem: ReturnType<typeof createNodeFsScanDeps>;
  skillsFilesystem: ReturnType<typeof createSecureSkillsFs>;
}

/**
 * The desktop AgentStreamCapabilities composition (BST-972 B4a): every value
 * the stream initializer previously imported from desktop modules, passed
 * verbatim. Kept at the ROOT so suites that vi.mock these specifiers keep
 * intercepting (only assistant-tools, mastra-memory, and
 * workspace-text-file-reader are mocked today; the census is on the BST-972
 * plan comment). The two matchers use the REAL error classes, so identity
 * semantics are unchanged. The identity-pin test in
 * agent-stream-init-and-memory.integration.test.ts guards the same-signature
 * members against transposition.
 */
export const desktopAgentStreamCapabilities: AgentStreamCapabilities<DesktopAgentStreamKinds> = {
  artifacts: {
    createRepository: (database) => new ToolOutputArtifactRepository(database),
  },
  compaction: {
    createContextOverflowRecovery,
    runPreRequest: runPreRequestCompaction,
  },
  contextInjectors: {
    activatedSkills: injectActivatedSkillsContext,
    referencedFiles: injectReferencedFilesContext,
    selfImprovementSignal: injectSelfImprovementSignalContext,
    workspaceInstructions: injectWorkspaceInstructionsContext,
  },
  hooks: {
    eventToAssistant: hookRunEventToAssistant,
    finalize: finalizeHookedStream,
    makeBlockedStream: makeHookBlockedStream,
    prepare: prepareRequestHooks,
    runUserPromptSubmitGate,
  },
  memory: {
    create: getDesktopMastraMemory,
    matchCredentialMissingError: (error) =>
      error instanceof DesktopMemoryCredentialMissingError
        ? { feature: error.feature, message: error.message, provider: error.provider }
        : undefined,
  },
  personas: {
    createScanDeps: createNodeFsScanDeps,
    resolve: resolveRequestPersonas,
    scan: scanUserPersonas,
  },
  readWorkspaceTextFile,
  runPersistence: {
    observeRunEvents: observeDesktopAssistantRunEvents,
    persistChildRunUsage: persistDesktopChildRunUsage,
    persistTokenEstimateCalibration: persistDesktopTokenEstimateCalibration,
    persistToolCallTelemetry: persistDesktopToolCallTelemetry,
    recordContinuationRunTreatment: recordDesktopContinuationRunTreatment,
    recordHookRunOutcome: recordDesktopAssistantHookRunOutcome,
  },
  skills: {
    createFs: createSecureSkillsFs,
    prepare: prepareRequestSkills,
  },
  taskList: {
    read: readThreadTaskList,
  },
  tools: {
    build: buildDesktopAssistantTools,
  },
  webExtractInlineMaxSerializedChars: WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS,
  workspaceRoots: {
    enrich: enrichRuntimeDataWithWorkspaceRoots,
    matchBoundRootUnavailableError: (error) =>
      error instanceof BoundWorkspaceRootUnavailableError ? { message: error.message } : undefined,
  },
};

/** RunPersistencePort adapter: the desktop status writer with db-main closed over. */
const desktopRunPersistencePort = {
  recordThreadRunStatus: (
    runId: string,
    status: 'cancelled' | 'completed' | 'failed',
    error: string | null
  ) => recordDesktopAssistantThreadRunStatus(runId, status, error, getDatabase),
};

export { desktopAssistantServerLogger };

/**
 * Best-effort warm-up for the bundled-CPython capability (BST-1061, PR #2205
 * review): unpacking a ~250MB CPython tree is the only slow part of
 * `resolveDesktopPythonExecutable`, and doing it here — once, at server
 * start — means the first real `python3` skill-script call almost always
 * hits the cheap already-unpacked path instead of paying that cost inline
 * (where it used to run before `startedAt` and outside any timeout bound).
 * This is a PERFORMANCE optimization, not a correctness dependency:
 * `run-skill-script-tool.ts` still bounds a cold resolve by the caller's own
 * timeout/Stop regardless of whether this warm-up won the race. Failure is
 * logged, never thrown — an unsupported platform (win/linux) or a missing
 * archive (dev checkout that hasn't run `fetch:python-runtime`) must not
 * block the assistant server from starting.
 */
function warmBundledPythonRuntime(): void {
  const logWarmupFailure = (error: unknown) => {
    logger.warn(
      'Bundled Python runtime warm-up failed; the first python3 skill script will pay for it',
      { error: error instanceof Error ? error.message : String(error) }
    );
  };
  try {
    resolveDesktopPythonExecutable().catch(logWarmupFailure);
  } catch (error) {
    // Defensive: resolveDesktopPythonExecutable's synchronous prelude reads
    // `app.getPath`/`app.getAppPath` before it starts returning a Promise —
    // a `.catch()` alone cannot see a throw that happens before that.
    logWarmupFailure(error);
  }
}

export function startAssistantServer(portHint?: number, options: AssistantServerOptions = {}) {
  warmBundledPythonRuntime();
  const auth: AssistantServerAuth = options.auth ?? { token: mintAssistantServerAuthToken() };
  const authToken = auth === 'disabled' ? undefined : auth.token;
  const requestOptions: AssistantServerOptions = { ...options, auth };
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res, requestOptions).catch(() => {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      applyAssistantCorsHeaders(req, res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'assistant server error' }));
    });
  });

  const port = Number(process.env['BS_ASSISTANT_PORT'] ?? portHint ?? 0) || 0;
  const host = options.host ?? '127.0.0.1';
  if (options.listen === false) {
    return Promise.resolve({
      ...(authToken === undefined ? {} : { authToken }),
      stop: async () => {},
      url: `http://${host}:${port}`,
    });
  }
  return new Promise<{ url: string; stop: () => Promise<void>; authToken?: string }>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      resolve({
        ...(authToken === undefined ? {} : { authToken }),
        stop: async () => await new Promise<void>((r) => server.close(() => r())),
        url,
      });
    });
  });
}

export async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions = {}
): Promise<void> {
  const auth = options.auth;
  if (auth === undefined) {
    // NO SILENT FALLBACKS: an unconfigured gate must fail loudly, never serve.
    throw new Error(
      'Assistant server auth is not configured. Pass options.auth ({ token } or the explicit "disabled" opt-out).'
    );
  }

  if (hasDisallowedAssistantOrigin(req)) {
    respondForbiddenOrigin(res);
    return;
  }

  applyAssistantCorsHeaders(req, res);

  if (isAssistantCorsPreflight(req)) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    auth !== 'disabled' &&
    !isAuthorizedAssistantToken(req.headers[ASSISTANT_AUTH_HEADER_NAME], auth.token)
  ) {
    logger.warn('Rejected assistant request without a valid auth token', {
      method: req.method,
      url: req.url,
    });
    respondJson(res, 401, {
      error: 'unauthorized',
      message: 'Missing or invalid assistant auth token.',
    });
    return;
  }

  const route = resolveAssistantRoute(req);
  if (route === 'status') {
    await handleAssistantStatus(res, options);
    return;
  }

  if (route === 'openrouter-model') {
    await handleOpenRouterModelMetadata(req, res, options);
    return;
  }

  if (route === 'verify-provider') {
    await handleVerifyProviderRequest(req, res, options);
    return;
  }

  if (route === 'suspended-runs') {
    await handleSuspendedRunsRequest(req, res, options);
    return;
  }

  if (route === 'run-status') {
    await handleRunStatusRequest(req, res, getDatabase);
    return;
  }

  if (route === 'steer') {
    await handleSteerRequest(req, res);
    return;
  }

  if (route === 'cancel') {
    await handleCancelRequest(req, res);
    return;
  }

  if (route === 'resume') {
    await handleAssistantResumeRequest(req, res);
    return;
  }

  if (route === 'not-found') {
    respondNotFound(res);
    return;
  }

  await handleAssistantPost(req, res, options);
}

/** Same narrowing cast the changes IPC handlers use for the shared handle. */
async function resolveEditCheckpointDatabase(): Promise<EditCheckpointDatabase> {
  return (await getDatabase()) as unknown as EditCheckpointDatabase;
}

/**
 * EVERY workspace root a turn-boundary snapshot must cover (plan T2: the
 * turn-start/turn-end snapshots span every root, not only the bound one).
 * Reuses the authoritative enrichment (`workspaceRoots` trusted when present,
 * otherwise resolved from the DB roots table) so snapshot root ids match
 * `file_records.root_id` and the edit-checkpoint journal's `rootId`.
 */
async function resolveSnapshotWorkspaceRoots(
  runtimeData: RuntimeData
): Promise<readonly { readonly path: string; readonly rootId: string }[]> {
  const enriched = await enrichRuntimeDataWithWorkspaceRoots(runtimeData, await getDatabase());
  return getWorkspaceRoots(enriched).map((root) => ({ path: root.path, rootId: root.rootId }));
}

/**
 * BST-1352: the factory auth input derives from the TYPED credential the
 * request resolved and travels as a direct parameter (runAssistantTurn →
 * initializeAgentStream → stream options) — never on runtimeData /
 * RequestContext (toJSON drops functions). Preparation GUARANTEES the
 * provider string on prepared runtime data (withTrustedAssistantMessageId
 * stamps it), so its absence is a wiring bug asserted loudly — never coerced
 * to an empty provider name.
 */
async function deriveAssistantTurnAuthInput(
  runtimeData: RuntimeData,
  credential: Parameters<typeof providerAuthInputFromCredential>[1]
): Promise<ReturnType<typeof providerAuthInputFromCredential>> {
  const provider = runtimeData.provider;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(
      'Prepared assistant runtime data is missing its provider; request preparation must stamp it.'
    );
  }
  // BST-1353 + PR #2525 finding 2: the chain is RESOLVED HERE, before the
  // provider reaches the AI SDK, because the SDK replaces any rejection from
  // `credentialProvider` with a plain Error — a lazily-throwing chain would
  // lose its typed code and awsAuthMode context on the way to the run-error
  // envelope. Resolving in this async scope keeps the typed error intact.
  //
  // Still per-request: this runs once per turn, so a mid-session
  // `aws sso login` is picked up on the next message.
  const awsCredentialChain =
    credential?.type === 'aws' && credential.mode === 'profile_chain'
      ? await preresolveAwsChain(credential.profile)
      : createAwsCredentialChain;

  // The closure is desktop-main-only: it never crosses IPC and is never
  // serialized (RequestContext.toJSON drops functions).
  //
  // BST-1356: the subscription-fetch capability is the interactive-only gate
  // for `oauth_subscription` providers (legal gate BST-1351, constraint 4).
  // It is `undefined` in any process that never initialized the provider-auth
  // runtime, and the projection's oauth arm REJECTS the credential when it is
  // absent — so headless/web fail closed rather than degrade.
  const oauthSubscriptionFetch = getSubscriptionFetchFactory();
  return providerAuthInputFromCredential(provider, credential, {
    awsCredentialChain,
    ...(oauthSubscriptionFetch === undefined ? {} : { oauthSubscriptionFetch }),
  });
}

/**
 * Resolve the chain once and present it as the projection's sync capability.
 * A failure throws the TYPED chain error out of this async scope — which is
 * the entire point (see finding 2 above).
 */
async function preresolveAwsChain(
  profile: string | undefined
): Promise<() => AwsCredentialIdentityProvider> {
  const resolved = await resolveAwsCredentialChain(profile);
  return () => resolved;
}

/**
 * Derivation runs inside the handled scope (BST-1352 review finding 8): an
 * UnsupportedCredentialTypeError is SecretReadError-shaped, so it maps to the
 * same classified api_key_unreadable 400 as every other secret failure
 * instead of escaping as an unhandled throw. `ok: false` means the response
 * was already written.
 */
async function deriveAuthInputOrRespond(
  res: http.ServerResponse,
  runtimeData: RuntimeData,
  credential: Parameters<typeof providerAuthInputFromCredential>[1]
): Promise<
  { ok: true; authInput: Awaited<ReturnType<typeof deriveAssistantTurnAuthInput>> } | { ok: false }
> {
  try {
    return { authInput: await deriveAssistantTurnAuthInput(runtimeData, credential), ok: true };
  } catch (error) {
    if (respondToSecretReadError(res, error)) {
      return { ok: false };
    }
    // A typed chain failure (mastra_agent_runtime_init_failed) is NOT
    // secret-read-shaped, so it deliberately falls through to the caller's
    // run-error handling with its code and actionable detail intact.
    throw error;
  }
}

/** W7 T2 gate extracted for the cognitive-complexity budget: a controller
 * exists only for a persisted run (runId + threadId) with snapshot deps. */
function resolveTurnBoundariesForRun(
  options: AssistantServerOptions,
  runId: string | undefined,
  threadId: string | undefined
): ReturnType<typeof createTurnBoundaryController> | null {
  if (!(options.snapshots && runId && threadId)) {
    return null;
  }
  return createTurnBoundaryController({
    resolveDatabase: resolveEditCheckpointDatabase,
    snapshots: options.snapshots,
  });
}

/**
 * `createdBy: 'agent'` and the run/thread ids are bound HERE, never taken from
 * tool input: provenance the model can set is provenance the model can forge.
 */
function buildDesktopToolDependencies(
  options: AssistantServerOptions,
  // `runId` matches StreamInitializer's actual param shape (ports.ts): a
  // REQUIRED key whose value may be undefined, not an optional key — under
  // exactOptionalPropertyTypes the two are not interchangeable, and the real
  // `core` passed at the call site always carries the key.
  core: { readonly runId: string | undefined; readonly runtimeData?: RuntimeData }
): { shellCorrelation?: ShellCorrelationCapability; worktreeTools?: WorktreeToolCapability } {
  const service = options.resolveWorktreeService?.() ?? null;
  const forge = options.resolveForgeService?.() ?? null;
  const runId = core.runId;
  const threadId = core.runtimeData?.memory?.threadId;
  const worktreeTools: WorktreeToolCapability | undefined = service
    ? {
        archive: (params) => service.archive({ ...params, ...(runId ? { runId } : {}) }),
        create: (params) =>
          service.create({
            ...params,
            branch: { name: params.branch },
            createdBy: 'agent',
            ...(runId ? { runId } : {}),
            ...(threadId ? { threadId } : {}),
          }),
        list: () => service.list(),
      }
    : undefined;
  const shellCorrelation: ShellCorrelationCapability | undefined =
    service || forge
      ? createShellCorrelation({
          forgeRefresh: (rootId) => {
            // `refresh` returns a Promise; `void`-ing the call alone let its
            // rejection go unhandled. `.catch` per the same shape
            // `onRepositoryInvalidated` already uses (forge-service.ts:626).
            forge?.refresh(rootId, 'shell').catch((error: unknown) => {
              logger.error('shell forge refresh threw', { error, rootId });
            });
          },
          reconcile: async (rootId, precedingWorktreePaths) => {
            if (!service) {
              return { error: 'Worktrees are unavailable in this session.', ok: false };
            }
            const context = await service.repositoryContextForRoot(rootId);
            if (!context.ok) {
              return context;
            }
            return await service.reconcileFromShell({
              precedingWorktreePaths,
              repoCommonDir: context.value.commonDir,
              ...(runId ? { runId } : {}),
              ...(threadId ? { threadId } : {}),
            });
          },
        })
      : undefined;
  return {
    ...(shellCorrelation ? { shellCorrelation } : {}),
    ...(worktreeTools ? { worktreeTools } : {}),
  };
}

async function handleAssistantPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions
): Promise<void> {
  const prepared = await prepareAssistantPostRequest({
    // BST-1353: desktop main is the ONLY host that can resolve local AWS
    // profiles, so it is the only one that supplies the chain builder.
    awsCredentialChain: createAwsCredentialChain,
    logger,
    readBody: () => readRequestBody(req, { maxBodyBytes: assistantRequestBodyLimitBytes }),
    resolveProviderCredential,
  });
  if (!prepared.ok) {
    respondAssistantRejection(res, prepared.rejection);
    return;
  }
  const {
    assistantMessageId,
    credential,
    messages,
    runtimeData,
    apiKey,
    toolApprovalAction,
    toolResumeAction,
  } = prepared.request;
  const derivedAuthInput = await deriveAuthInputOrRespond(res, runtimeData, credential);
  if (!derivedAuthInput.ok) {
    return;
  }
  const { authInput } = derivedAuthInput;

  const lastEventId = readLastEventId(req);
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  const { signal: requestSignal, cleanup } = registerRequestAbort(req, res);
  const executionAbortController = new AbortController();
  const runId = runtimeData.memory?.runId;
  const threadId = runtimeData.memory?.threadId;

  // W7 T2 (BST-1164): shadow-git turn boundaries on the run-persistence seam.
  // Only a persisted run (runId + threadId) with the snapshot deps wired
  // participates; snapshot bookkeeping NEVER blocks or fails the run.
  const turnBoundaries = resolveTurnBoundariesForRun(options, runId, threadId);
  const legPause: LegPauseState = { paused: false };
  if (turnBoundaries && runId && threadId) {
    try {
      await turnBoundaries.beginLeg({
        // TURN ANCHOR: the triggering user message, never the run row (a turn
        // is not a run — approval/suspend resumes mint additional run rows).
        anchorMessageId: resolveTurnAnchorMessageId(messages),
        isResume: toolApprovalAction !== undefined || toolResumeAction !== undefined,
        roots: await resolveSnapshotWorkspaceRoots(runtimeData),
        runId,
        threadId,
      });
    } catch (error) {
      // beginLeg itself never throws; this guards the roots resolution. A run
      // is never blocked by snapshot bookkeeping — the turn simply has no
      // recorded start and its changeset resolves to the typed honest error.
      logger.error('Turn-start snapshot bookkeeping failed; the run proceeds', {
        error,
        runId,
        threadId,
      });
    }
  }
  // Turn-end snapshots complete BEFORE the terminal thread_runs status write
  // (plan global constraint 5): the port wrapper runs completeLeg first, so
  // by the time the run reads terminal the turn-end ledger rows exist.
  const persistence =
    turnBoundaries && threadId
      ? {
          recordThreadRunStatus: async (
            legRunId: string,
            status: 'cancelled' | 'completed' | 'failed',
            error: string | null
          ) => {
            await turnBoundaries.completeLeg({
              paused: legPause.paused,
              runId: legRunId,
              status,
              threadId,
            });
            await desktopRunPersistencePort.recordThreadRunStatus(legRunId, status, error);
          },
        }
      : desktopRunPersistencePort;
  // Only THIS leg's registration may be torn down below: on the defensive
  // duplicate-runId throw the entry belongs to the ORIGINAL still-streaming
  // leg, and unregistering it would make a genuinely active run un-steerable
  // (spurious 404). Review finding, BST-588.
  let registeredSteerableRun = false;
  try {
    // Steering control (BST-588): in-memory only, injected AFTER request
    // validation exactly like `signal`. Every streaming leg with a runId is
    // steerable; the registry entry dies with the stream. Registered INSIDE
    // the try so a defensive duplicate-runId throw still runs cleanup() and
    // answers the request (review P3).
    if (runId) {
      runtimeData.steering = registerSteerableRun(runId, executionAbortController);
      registeredSteerableRun = true;
    }
    // Orchestration lives in the service package since B3; this transport
    // composes the initializer (MCP config + desktop adapters closed over)
    // and the persistence port, then pumps the returned WHATWG Response and
    // awaits completion — the pre-B3 order exactly.
    const turn = await runAssistantTurn({
      apiKey,
      assistantMessageId,
      authInput,
      executionSignal: executionAbortController.signal,
      initializeStream: async (core) => {
        // Apps admission is keyed by the OWNING THREAD (review finding on
        // BST-1572): an app mounted in thread A must never execute under a
        // later run of thread B that knows the same server. A run without a
        // persisted thread publishes no admission (no key to correlate on).
        const admissionRun =
          core.runId && core.runtimeData?.memory?.threadId
            ? { runId: core.runId, threadId: core.runtimeData.memory.threadId }
            : undefined;
        const result = await initializeAgentStream({
          apiKey: core.apiKey,
          authInput: core.authInput,
          capabilities: desktopAgentStreamCapabilities,
          compactionOverlayLookup,
          getDatabase,
          logger,
          mcpConfig: undefined,
          ...(admissionRun
            ? {
                mcpAppAdmission: {
                  register: (admission) => {
                    const appHost = getMcpDesktopAppHost();
                    appHost.registerAdmission(admissionRun, admission);
                    return () => appHost.invalidateAdmission(admissionRun);
                  },
                },
              }
            : {}),
          mcpHost: getDesktopMcpHostRuntime().host,
          mcpTaskTracking: getDesktopMcpHostRuntime().taskHost,
          messages: core.messages,
          resolveProviderApiKey,
          runId: core.runId,
          runtimeData: core.runtimeData,
          signal: core.signal,
          toolApprovalAction: core.toolApprovalAction,
          toolDependencies: {
            embeddingHostManager: options.embeddingHostManager,
            llmHostManager: options.llmHostManager,
            ...buildDesktopToolDependencies(options, core),
          },
          toolProjectionRewriteLookup,
          toolResumeAction: core.toolResumeAction,
        });
        if (!(turnBoundaries && result.ok)) {
          return result;
        }
        // Pause observation (W7 T2): a leg that ends in a resumable
        // approval/suspend pause is NOT the turn's last run, so its terminal
        // status write must not trigger turn-end snapshots. Pure passthrough.
        return { ...result, stream: observeTurnPauseChunks(result.stream, legPause) };
      },
      messages,
      persistence,
      runId,
      runtimeData,
      sessions: assistantDataStreamSessions,
      toolApprovalAction,
      toolResumeAction,
    });
    if (!turn.ok) {
      respondJson(res, turn.status, turn.payload);
      return;
    }
    await streamResponse(res, turn.response, requestSignal);
    await turn.completion();
  } catch (error) {
    await handleAssistantPostStreamError({
      completeTurnLeg:
        turnBoundaries && threadId
          ? (legRunId, status) =>
              turnBoundaries.completeLeg({
                paused: legPause.paused,
                runId: legRunId,
                status,
                threadId,
              })
          : null,
      error,
      res,
      runId,
      signal: executionAbortController.signal,
    });
  } finally {
    if (runId && registeredSteerableRun) {
      unregisterSteerableRun(runId);
    }
    cleanup();
  }
}

async function handleAssistantPostStreamError({
  completeTurnLeg,
  res,
  runId,
  signal,
  error,
}: {
  /** W7 T2: turn-end snapshot hook, run BEFORE the terminal status write. */
  readonly completeTurnLeg:
    | ((runId: string, status: 'cancelled' | 'failed') => Promise<void>)
    | null;
  readonly res: http.ServerResponse;
  readonly runId: string | undefined;
  readonly signal: AbortSignal;
  readonly error: unknown;
}): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (runId) {
    const status = signal.aborted ? 'cancelled' : 'failed';
    if (completeTurnLeg) {
      await completeTurnLeg(runId, status);
    }
    await recordDesktopAssistantThreadRunStatus(runId, status, message, getDatabase);
  }
  if (signal.aborted) {
    return;
  }
  logger.error('Assistant stream error', { error });
  if (res.headersSent) {
    return;
  }
  respondJson(res, 500, {
    error: 'assistant_stream_failed',
    message: 'Assistant stream failed.',
  });
}
