/**
 * The request-scoped inputs every desktop native-tool executor builds from,
 * and the exhaustive executor-map type (BST-1646 step c).
 *
 * Kept in its own leaf module so the four executor group files and
 * `assistant-tools.ts` can share these types without importing each other.
 */
import type {
  RuntimeData,
  ScaledToolResultBudget,
  ScannedWorkspaceSkills,
  ScopedToolOutputArtifactReader,
} from '@brainstrike/agent';
import type { DesktopNativeTool, DesktopNativeToolId } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { CommandSessionManager } from './command-session-manager';
import type { ReadWorkspaceFileCursorRegistry } from './read-workspace-file-cursor-registry';
import type { ShellCorrelationCapability } from './shell-worktree-correlation';
import type { WebExtractToolDependencies } from './web-extract-tool';
import type { WebSearchToolDependencies } from './web-search-tool';
import type { WorktreeToolCapability } from './worktree-tools';

export type MastraTools = NonNullable<RuntimeData['mastraTools']>;
export type MastraTool = MastraTools[string];

export interface DesktopAssistantToolDependencies {
  /** Main's admitted CLI subset; undefined retains ordinary Desktop collection scope. */
  admittedWorkspaceRootIds?: readonly string[] | undefined;
  commandSessionManager?: CommandSessionManager | undefined;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  nativeIndexSearch?: IndexSearchCapability | undefined;
  readWorkspaceFileCursorRegistry?: ReadWorkspaceFileCursorRegistry | undefined;
  resolvedToolResultBudget?: ScaledToolResultBudget | undefined;
  /**
   * BST-1061: test seam for the bundled-CPython capability used by the
   * `python3` skill-script runtime. Production omits it and gets the real
   * `resolveDesktopPythonExecutable`; there is never a PATH-python fallback.
   * Accepts an optional `AbortSignal` so a cold first-run unpack can be
   * bounded by the tool call's own timeout/Stop (PR #2205 review).
   */
  resolvePythonExecutable?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  /** Trusted desktop helper capability; the default resolves the physical packaged helper. */
  resolveSeccompApplyPath?: (() => string | undefined) | undefined;
  /**
   * Request-scoped shell correlation (BST-1392). Absent means no correlation,
   * which is the honest state for a session with no worktree/forge service:
   * the command still runs and its result is unchanged.
   */
  shellCorrelation?: ShellCorrelationCapability | undefined;
  skillScriptResolver?: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> | undefined;
  toolOutputArtifactReader?: ScopedToolOutputArtifactReader | undefined;
  /**
   * Optional override for the webSearch tool's network/key resolution. Used by
   * tests to inject a stubbed Tavily fetch and key resolver so the loop runs
   * hermetically. In production this is omitted and runWebSearch resolves the
   * real keychain key and uses the real fetch.
   */
  /** Same injection seam as `webSearch`, for the webExtract tool. */
  webExtract?: WebExtractToolDependencies | undefined;
  webSearch?: WebSearchToolDependencies | undefined;
  /**
   * Request-scoped worktree capability (BST-1392). Built in
   * `assistant-server.ts`, where the run id is in scope, so the ledger records
   * `created_by='agent'` and the originating `run_id` by construction.
   */
  worktreeTools?: WorktreeToolCapability | undefined;
}

/** What one request hands every executor entry. */
export interface DesktopToolBuildContext {
  readonly dependencies: DesktopAssistantToolDependencies;
  /**
   * True when the request targets the built-in on-device provider. The
   * entries that omit themselves for it (task list, suspending tools, browser
   * pane, canvas, sessions, worktrees) say why beside their own gate.
   */
  readonly isLocalProvider: boolean;
  readonly readFileCursorRegistry: ReadWorkspaceFileCursorRegistry;
  /** The live per-call domain budget, falling back to the request's resolved one. */
  readonly resolveActiveDomainCharBudget: () => number;
  readonly resolvedDomainCharBudget: number;
  readonly runtimeData: RuntimeData | undefined;
}

/**
 * Builds one tool's request-scoped Mastra registry entry, or `undefined` when
 * the capability is ABSENT for this request (built-in local provider, no
 * artifact reader, no skill resolver). Omission is the explicit capability
 * result, never a policy fallback.
 */
export type NativeToolExecutor = (context: DesktopToolBuildContext) => MastraTool | undefined;

/**
 * One executor per desktop native tool, keyed by every `brainstrike.*` id the
 * catalog declares. Derived from `NATIVE_TOOLS`, so adding a definition
 * without an executor entry (or an entry for an id no definition declares) is
 * a compile error here — the adapter half of the contract/adapter seam.
 */
export type NativeToolExecutorMap = {
  readonly [Tool in DesktopNativeTool as Tool['id']]: NativeToolExecutor;
};

/**
 * True when the request targets the built-in on-device provider. Mirrors
 * `isLocalChatProvider` in @brainstrike/assistant-service/local-provider-runtime (kept separate: that module
 * pulls in Electron IPC imports this file must stay free of for its own
 * unit-test surface).
 */
export function isLocalProviderRuntime(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

/**
 * Types one executor group by the catalog ids it declares. The explicit
 * return type keeps the group's declaration nameable (its entries close over
 * unexported result types) while still contextually typing every entry and
 * rejecting an id the catalog does not declare.
 */
export function executorGroup<const Ids extends DesktopNativeToolId>(
  group: {
    readonly [Id in Ids]: NativeToolExecutor;
  }
): { readonly [Id in Ids]: NativeToolExecutor } {
  return group;
}
